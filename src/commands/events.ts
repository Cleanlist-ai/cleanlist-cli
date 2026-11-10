import { createHmac } from 'node:crypto';
import { toError } from '../api.js';
import { type Command, type Ctx, list, parseDuration } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { printRows } from '../output.js';
import { VERSION } from '../version.js';
import { connectWebSocket } from '../ws.js';

/** The C4 webhook signature: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function forwardUrl(v: unknown): URL | undefined {
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    throw new CliError(EXIT.USAGE, `--forward-to "${v}" is not a URL.`, 'Pass a full URL, e.g. http://localhost:3000/webhooks.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError(EXIT.USAGE, '--forward-to must be an http or https URL.');
  return url;
}

/** POST one event to the developer's endpoint, signed like a webhook. Never throws: a down server shouldn't end the session. */
export async function forward(url: URL, secret: string, event: unknown): Promise<string> {
  const body = JSON.stringify(event);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cleanlist-signature': signature(secret, body), 'user-agent': `cleanlist-cli/${VERSION}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return `${res.status}`;
  } catch (e) {
    return `failed (${(e as Error).message})`;
  }
}

/** One stream line per event: JSON for machines, a short line in a terminal. */
function printEvent(ctx: Ctx, event: any, forwarded?: string): void {
  if (ctx.format === 'table') {
    process.stdout.write(`${event.created_at ?? new Date().toISOString()}  ${event.type}  ${event.id}${forwarded ? `  → ${forwarded}` : ''}\n`);
  } else if (ctx.format === 'csv') {
    printRows([{ id: event.id, type: event.type, created_at: event.created_at, forwarded: forwarded ?? '' }], 'csv', false, ['id', 'type', 'created_at', 'forwarded']);
  } else {
    process.stdout.write(JSON.stringify(event) + '\n');
  }
}

async function listen(ctx: Ctx): Promise<void> {
  const target = forwardUrl(ctx.opts['forward-to']);
  const events = list(ctx.opts.events);
  const url = new URL(ctx.apiUrl.replace(/\/$/, '') + '/api/v2/events/listen');
  if (events) url.searchParams.set('events', events.join(','));
  const token = await ctx.api.token();
  const seen = new Set<string>();
  let secret = '';
  let queue = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let errorFrame: any;
    const onFrame = (text: string) => {
      let frame: any;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.type === 'listening') {
        secret = frame.secret;
        ctx.log(`Listening for ${frame.events?.join(', ') || 'all events'}${target ? `, forwarding to ${target.href}` : ''}. Ctrl-C to stop.`);
        ctx.log(`Signing secret for this session: ${secret}`);
      } else if (frame.type === 'event' && frame.event) {
        const event = frame.event;
        // A retried emit can repeat an event.
        if (event.id && seen.has(event.id)) return;
        if (event.id) seen.add(event.id);
        if (seen.size > 5000) seen.clear();
        // In order, one forward at a time, like a webhook endpoint sees them.
        queue = queue.then(async () => printEvent(ctx, event, target ? await forward(target, secret, event) : undefined));
      } else if (frame.type === 'error') {
        errorFrame = frame;
      } else if (frame.type === 'closing') {
        ctx.log('Closed after an hour with no events. Run `cleanlist listen` again to keep listening.');
      }
    };
    const onClose = (code: number) => {
      // Refusals close with 4000 + the HTTP status, after an error frame.
      if (code >= 4000 && code < 5000) return reject(toError(code - 4000, errorFrame ?? {}));
      if (errorFrame) return reject(toError(500, errorFrame));
      if (code === 1000) return resolve();
      reject(new CliError(EXIT.ERROR, `The event stream closed unexpectedly (${code}).`, 'Run `cleanlist listen` again. Webhooks still deliver meanwhile.'));
    };
    connectWebSocket(url, { authorization: `Bearer ${token}`, 'user-agent': `cleanlist-cli/${VERSION} node/${process.version}` }, { message: onFrame, close: onClose })
      .then((conn) => {
        const stop = () => conn.close(1000);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      })
      .catch((e: any) => {
        if (e.status) {
          let body: any = e.body;
          try {
            body = JSON.parse(e.body);
          } catch {
            /* not JSON */
          }
          return reject(toError(e.status, body));
        }
        reject(new CliError(EXIT.ERROR, `Couldn't reach ${url.origin}: ${e.message}`));
      });
  });
  await queue;
}

const LOG_COLUMNS = ['time', 'method', 'status', 'path', 'duration_ms', 'tool', 'credits', 'key_prefix', 'client'];

/** --since: an ISO time, or a duration back from now (15m, 2h). */
export function sinceOpt(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  if (/^\d+(ms|s|m|h)?$/.test(s)) return new Date(Date.now() - parseDuration(s, 0)).toISOString();
  if (Number.isNaN(Date.parse(s))) throw new CliError(EXIT.USAGE, `--since "${s}" is not a time.`, 'Use an ISO time (2026-11-10T14:00:00Z) or a duration (15m, 2h).');
  return s;
}

/** Every page of /logs for these filters, newest first. */
async function fetchLogs(ctx: Ctx, query: Record<string, unknown>): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await ctx.api.get('/api/v2/logs', { ...query, limit: 200, cursor } as any);
    rows.push(...(data.logs ?? []));
    cursor = data.next_cursor ?? undefined;
  } while (cursor);
  return rows;
}

function printLogs(ctx: Ctx, rows: any[], header: boolean): void {
  if (ctx.format === 'table') {
    for (const r of rows) {
      process.stdout.write(`${r.time}  ${String(r.method).padEnd(6)} ${r.status}  ${r.path}  ${r.duration_ms}ms${r.credits ? `  ${r.credits} credits` : ''}\n`);
    }
  } else if (ctx.format === 'csv') printRows(rows, 'csv', header, LOG_COLUMNS);
  else printRows(rows, 'jsonl', false);
}

async function followLogs(ctx: Ctx, query: Record<string, unknown>): Promise<void> {
  let stopped = false;
  process.once('SIGINT', () => (stopped = true));
  const first = (await ctx.api.get('/api/v2/logs', { ...query, limit: Number(query.limit) || 20 } as any)).data.logs ?? [];
  // `since` matches rows at that exact time again, so remember the ids at the newest time seen.
  let since: string = first[0]?.time ?? query.since ?? new Date(Date.now() - 60_000).toISOString();
  let seen = new Set<string>(first.filter((r: any) => r.time === since).map((r: any) => r.id));
  printLogs(ctx, [...first].reverse(), true);
  while (!stopped) {
    await new Promise((r) => setTimeout(r, 2000));
    if (stopped) break;
    const fresh = (await fetchLogs(ctx, { ...query, since })).filter((r) => !seen.has(r.id));
    if (!fresh.length) continue;
    printLogs(ctx, [...fresh].reverse(), false);
    const newest = fresh[0].time;
    const atNewest = fresh.filter((r) => r.time === newest).map((r) => r.id);
    seen = new Set(newest === since ? [...seen, ...atNewest] : atNewest);
    since = newest;
  }
}

export const eventCommands: Command[] = [
  {
    name: 'listen',
    summary: 'Stream this workspace\'s webhook events live, and optionally forward each one, signed, to a local URL.',
    options: {
      events: { type: 'string', multiple: true, desc: 'Only these event types (comma-separated or repeated). Default: all.' },
      'forward-to': { type: 'string', desc: 'POST each event here with a Cleanlist-Signature header, like a webhook.' },
    },
    examples: [
      'cleanlist listen',
      'cleanlist listen --events reply.received,play_run.completed --forward-to http://localhost:3000/webhooks',
      'cleanlist listen --json | jq .type',
    ],
    async run(ctx) {
      await listen(ctx);
      return undefined;
    },
  },
  {
    name: 'logs',
    summary: 'This workspace\'s API requests, newest first. --follow streams new ones as they happen.',
    options: {
      since: { type: 'string', desc: 'From this ISO time, or this long ago (15m, 2h).' },
      status: { type: 'string', desc: 'An exact status (429) or a class (4xx, 5xx).' },
      path: { type: 'string', desc: 'Path prefix, e.g. /api/v2/lead-lists.' },
      limit: { type: 'string', desc: 'Rows per page, 1 to 200 (default 50).' },
      cursor: { type: 'string', desc: 'next_cursor from the previous page.' },
      follow: { type: 'boolean', short: 'f', desc: 'Keep printing new requests until Ctrl-C.' },
    },
    view: { rows: (d) => d.logs, columns: LOG_COLUMNS },
    examples: ['cleanlist logs --status 4xx --since 1h', 'cleanlist logs --follow', 'cleanlist logs --path /api/v2/enrichment --format csv > calls.csv'],
    async run(ctx) {
      const query = { since: sinceOpt(ctx.opts.since), status: ctx.opts.status, path: ctx.opts.path, limit: ctx.opts.limit, cursor: ctx.opts.cursor };
      if (ctx.opts.follow) {
        if (ctx.opts.cursor) throw new CliError(EXIT.USAGE, '--follow starts from the newest request; drop --cursor.');
        await followLogs(ctx, query);
        return undefined;
      }
      return (await ctx.api.get('/api/v2/logs', query)).data;
    },
  },
];
