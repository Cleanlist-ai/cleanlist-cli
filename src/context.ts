import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { type Api, MAX_WAIT_MS, retryDelayMs, sleep } from './api.js';
import { CliError, EXIT } from './errors.js';
import { type Format, info, type View } from './output.js';

export interface OptSpec {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  desc: string;
}

export interface Command {
  /** e.g. "lists rows" */
  name: string;
  args?: string;
  summary: string;
  /** Spends credits (goes through a quote) or deletes data. */
  paid?: boolean;
  options?: Record<string, OptSpec>;
  examples?: string[];
  view?: View;
  /** Needs no credential (login, skill, help). */
  noAuth?: boolean;
  run(ctx: Ctx): Promise<unknown>;
}

export interface Ctx {
  args: string[];
  opts: Record<string, any>;
  format: Format;
  /** Lazily built so `login`/`skill` work without a credential. */
  api: Api;
  profile: string;
  apiUrl: string;
  quiet: boolean;
  /** --test or CLEANLIST_MODE=test: use the profile's test key. */
  test: boolean;
  /** Write a progress line to stderr. */
  log(msg: string): void;
}

/** True when a human can answer a prompt. Agents, pipes and CI never get prompted. */
export function interactive(opts: Record<string, any>): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY && !opts['no-input'] && !process.env.CI);
}

export async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Signal used by --dry-run: print this instead of running the command. */
export class DryRun {
  constructor(readonly output: unknown) {}
}

export interface Quote {
  quote_id: string;
  estimated_cost: number;
  available_credits: number;
  row_count: number;
  sufficient: boolean;
  expires_at: number;
  tool: string;
  crm_note?: string | null;
  /** Agent and play runs only: what the run can do outside Cleanlist (`sends`, `crm_writes`). */
  effects?: string[] | null;
}

const EFFECT_TEXT: Record<string, string> = {
  sends: 'email people, message them on LinkedIn or enroll them in sequences',
  crm_writes: 'write to your CRM',
};

/** What a run's quote says it can do, in words. */
function effectsNote(effects: string[] | null | undefined): string {
  if (!effects) return '';
  if (!effects.length) return 'This run sends nothing and writes to no CRM.';
  return `This run can ${effects.map((e) => EFFECT_TEXT[e] ?? e).join(' and ')}.`;
}

/**
 * The paid-work gate. Quote the exact operation, show it, then:
 * --dry-run → print the quote; over --max-credits or balance → exit 5;
 * --yes → go; a TTY → ask; otherwise exit 7 with the quote on stdout so an
 * agent can show the human the cost and re-run with --yes.
 * Returns the quote_id to pass to the paid call.
 */
export async function confirmSpend(ctx: Ctx, estimate: Record<string, unknown>, what: string): Promise<Quote> {
  const { data: q } = await ctx.api.post<Quote>('/api/v2/credits/estimate', estimate);
  const summary = `${what}: ${q.estimated_cost.toLocaleString()} credits for ${q.row_count.toLocaleString()} row(s). Balance ${q.available_credits.toLocaleString()}.`;
  if (ctx.opts['dry-run']) throw new DryRun(q);
  const note = [effectsNote(q.effects), q.crm_note].filter(Boolean).join(' ');
  // Refusals carry the quote in the error; only log it when going ahead or asking.
  const announce = () => ctx.log(summary + (note ? `\n${note}` : ''));

  if (!q.sufficient) {
    throw new CliError(EXIT.CREDITS, `Not enough credits: needs ${q.estimated_cost}, balance ${q.available_credits}.`, 'Buy credits or narrow the job.', { quote: q });
  }
  const max = maxCredits(ctx);
  if (max !== undefined && q.estimated_cost > max) {
    throw new CliError(EXIT.CREDITS, `Quote of ${q.estimated_cost} credits is above --max-credits ${max}.`, 'Raise --max-credits, or narrow the job.', { quote: q });
  }
  // A run always asks, even at 0 credits: it can email people or write to a CRM.
  if (ctx.opts.yes || (q.estimated_cost === 0 && !q.effects)) {
    announce();
    return q;
  }
  if (interactive(ctx.opts)) {
    announce();
    if (await ask(q.estimated_cost ? `Spend ${q.estimated_cost.toLocaleString()} credits?` : 'Go ahead?')) return q;
    throw new CliError(EXIT.CONFIRM, 'Cancelled. No credits were spent.');
  }
  throw new CliError(
    EXIT.CONFIRM,
    `Confirmation required: ${summary}${note ? ` ${note}` : ''}`,
    `Show the user this cost${note ? ' and what it can do' : ''}. Re-run with --yes only after they approve it.`,
    { quote: q },
  );
}

/**
 * confirmSpend, then `send` with the quote_id. A retryable 5xx means the route
 * stopped before charging but may have spent the single-use quote, so get a
 * fresh quote under the same rules and send once more. Any other failure ends it.
 */
export async function spend<T>(ctx: Ctx, estimate: Record<string, unknown>, what: string, send: (quoteId: string) => Promise<T>): Promise<T> {
  const q = await confirmSpend(ctx, estimate, what);
  try {
    return await send(q.quote_id);
  } catch (e) {
    if (!(e instanceof CliError && e.exitCode === EXIT.ERROR && (e.detail?.error as { retryable?: unknown } | undefined)?.retryable === true)) throw e;
    ctx.log(`${e.message} Getting a fresh quote and trying once more.`);
    await sleep(Math.min(retryDelayMs(0, null, e.detail), MAX_WAIT_MS));
    return send((await confirmSpend(ctx, estimate, what)).quote_id);
  }
}

/**
 * Sends and CRM writes from code (cleanse-api #2938): the call without
 * `commit` runs nothing that leaves Cleanlist and answers `committed: false`
 * with a preview of who it reaches (a change that leaves nothing just runs).
 * --yes sends `commit: true` at once. Otherwise the preview is shown: a TTY
 * asks, and anything else exits 7 with it on stdout.
 */
export async function commit(ctx: Ctx, send: (commit: boolean) => Promise<any>): Promise<unknown> {
  if (ctx.opts['dry-run']) throw new CliError(EXIT.USAGE, '--dry-run is not supported here.', 'Run it without --yes: anything that emails people or writes to a CRM shows a preview and sends nothing.');
  if (ctx.opts.yes) return send(true);
  const first = await send(false);
  if (first?.committed !== false) return first;
  const summary = String(first.preview?.summary ?? first.description ?? 'This reaches outside Cleanlist.');
  if (interactive(ctx.opts)) {
    ctx.log(summary);
    if (await ask('Go ahead?')) return send(true);
    throw new CliError(EXIT.CONFIRM, 'Cancelled. Nothing was sent.');
  }
  throw new CliError(EXIT.CONFIRM, `Confirmation required: ${summary}`, 'Show this to the user. Re-run with --yes only after they approve it.', { preview: first });
}

/**
 * Turning an agent on, its live run and a play run: the route's preview (what
 * it does, the most it spends, its sends and CRM writes), the quote it names,
 * then the same call with the quote_id and `commit: true`. A key missing an
 * opt-in scope the run needs stops before the quote.
 */
export async function liveRun(ctx: Ctx, path: string, body: Record<string, unknown>, what: string): Promise<any> {
  const { data: preview } = await ctx.api.post(path, body);
  if (preview?.committed !== false) return preview;
  const missing: string[] = preview.missing_scopes ?? [];
  if (missing.length) {
    throw new CliError(
      EXIT.AUTH,
      `This API key needs the ${missing.map((s) => `"${s}"`).join(' and ')} scope to ${what.toLowerCase()}: ${effectsNote(preview.effects)}`,
      `In the Cleanlist portal open Settings → API keys, edit this key and tick ${missing.join(' and ')}, then run it again.`,
      { preview },
    );
  }
  if (preview.description) ctx.log(preview.description);
  return spend(ctx, preview.estimate, what, async (quote_id) => (await ctx.api.post(path, { ...body, quote_id, commit: true })).data);
}

/** Read one line from the terminal without echoing it. */
function askSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value.trim()));
        if (ch === '\u0003') return done(() => reject(new CliError(EXIT.USAGE, 'Cancelled.')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** An API key flag value; `-` is a hidden prompt in a terminal (ends on Enter), else the pipe. */
export async function readKey(v: unknown): Promise<string> {
  return v !== '-' ? String(v) : process.stdin.isTTY ? askSecret('Paste your Cleanlist API key: ') : readInput('-').trim();
}

/** --max-credits as a number. Anything else (1,000 or 5k) exits 2 so the cap is never silently off. */
export function maxCredits(ctx: Ctx): number | undefined {
  const v = ctx.opts['max-credits'];
  if (v === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(String(v).trim())) throw new CliError(EXIT.USAGE, `--max-credits must be a number, like 1000 (got "${v}").`);
  return Number(v);
}

function parseJsonFlag(v: unknown, name: string): unknown {
  try {
    return JSON.parse(String(v));
  } catch (e) {
    throw new CliError(EXIT.USAGE, `--${name} is not valid JSON: ${(e as Error).message}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A flag holding a JSON object (`--args '{"a":1}'`). */
export function jsonOpt(v: unknown, name: string): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  const parsed = parseJsonFlag(v, name);
  if (!isObject(parsed)) throw new CliError(EXIT.USAGE, `--${name} must be a JSON object.`);
  return parsed;
}

/** A flag holding a JSON array of objects (`--changes '[{...}]'`). */
export function jsonArray(v: unknown, name: string): Record<string, unknown>[] | undefined {
  if (v === undefined) return undefined;
  const parsed = parseJsonFlag(v, name);
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every(isObject)) throw new CliError(EXIT.USAGE, `--${name} must be a JSON array of objects.`);
  return parsed;
}

/** The first positional argument, or exit 2 naming it and the command that lists them. */
export function requireArg(ctx: Ctx, what: string, see?: string): string {
  const v = ctx.args[0];
  if (!v) throw new CliError(EXIT.USAGE, `Pass the ${what}.`, see ? `See \`cleanlist ${see}\`.` : undefined);
  return v;
}

/** Ask before destructive, non-billed actions (delete). Same TTY/--yes rules as confirmSpend. */
export async function confirmAction(ctx: Ctx, question: string): Promise<void> {
  if (ctx.opts.yes) return;
  if (interactive(ctx.opts)) {
    if (await ask(question)) return;
    throw new CliError(EXIT.CONFIRM, 'Cancelled. Nothing was changed.');
  }
  throw new CliError(EXIT.CONFIRM, `Confirmation required: ${question}`, 'Re-run with --yes.');
}

const TERMINAL = new Set(['completed', 'completed_with_errors', 'complete', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled', 'partial', 'done']);
export const isTerminal = (status?: string) => TERMINAL.has(String(status ?? '').toLowerCase());

/** Duration like 90s, 10m, 1h → ms. */
export function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new CliError(EXIT.USAGE, `Bad duration "${s}". Use e.g. 90s, 10m, 1h.`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'] as number);
}

/**
 * Poll until `done(data)`. Backoff 2s → 15s. On timeout exit 8 with the
 * command that resumes the wait.
 */
export async function poll<T>(ctx: Ctx, fetchOnce: () => Promise<T>, done: (d: T) => boolean, resume: string, progress?: (d: T) => string): Promise<T> {
  const deadline = Date.now() + parseDuration(ctx.opts.timeout, 30 * 60_000);
  let delay = 2000;
  for (;;) {
    const data = await fetchOnce();
    if (done(data)) return data;
    if (progress) ctx.log(progress(data));
    if (Date.now() + delay > deadline) {
      throw new CliError(EXIT.TIMEOUT, 'Still running; stopped waiting.', `Resume with: ${resume}`, { last: data as any });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept a list UUID or its exact name. Ambiguous names exit 2 with the candidates. */
export async function resolveList(ctx: Ctx, ref: string | undefined): Promise<string> {
  if (!ref) throw new CliError(EXIT.USAGE, 'Pass a list id or exact list name.');
  if (UUID.test(ref)) return ref;
  const matches: { list_id: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await ctx.api.get('/api/v2/lead-lists', { limit: 100, cursor }); // API max
    for (const l of data.lists ?? []) if (l.name === ref) matches.push(l);
    cursor = data.cursor ?? undefined;
  } while (cursor && matches.length < 2);
  if (matches.length === 1) return matches[0].list_id;
  if (!matches.length) throw new CliError(EXIT.NOT_FOUND, `No list named "${ref}".`, 'See `cleanlist lists`.');
  throw new CliError(EXIT.USAGE, `More than one list is named "${ref}". Use its id.`, undefined, { candidates: matches });
}

/** Read a file path, or stdin when the path is "-". */
export function readInput(path: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e) {
    throw new CliError(EXIT.USAGE, `Couldn't read ${path === '-' ? 'stdin' : path}: ${(e as Error).message}`);
  }
}

/** Repeatable flag values, also split on commas (`--function Sales,Marketing`). */
export function list(v: unknown, split = true): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = (Array.isArray(v) ? v : [v]).map(String);
  const out = split ? arr.flatMap((s) => s.split(',')) : arr;
  const clean = out.map((s) => s.trim()).filter(Boolean);
  return clean.length ? clean : undefined;
}

export function intOpt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError(EXIT.USAGE, `--${name} must be a whole number.`);
  return n;
}

export const logTo = (quiet: boolean) => (msg: string) => info(msg, quiet);
