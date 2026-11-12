import { ask, type Command, type Ctx, interactive, jsonOpt, maxCredits, requireArg } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;

interface ActionResult {
  action: string;
  session_id: string;
  kind: 'result' | 'card';
  result?: unknown;
  card?: { card_id: string; title: string; summary: string; credits_required: number | null; expires_at: string };
}

/**
 * An action that ran and failed answers 200 with `{error, message}` as its
 * result (a confirm also says `status: failed`). Exit non-zero with it, so a
 * script or agent doesn't read a failure as done.
 */
function okOrThrow<T extends { result?: unknown; status?: string }>(data: T, extra: Record<string, unknown> = {}): T {
  const r = data?.result as { error?: unknown; message?: unknown } | undefined;
  const code = r && typeof r === 'object' && r.error ? String(r.error) : undefined;
  if (!code && data?.status !== 'failed') return data;
  const message = typeof r?.message === 'string' && r.message ? r.message : code ?? 'The action failed.';
  const exit = code === 'insufficient_credits' ? EXIT.CREDITS : code === 'plan_required' ? EXIT.AUTH : EXIT.ERROR;
  throw new CliError(exit, message, undefined, { error: { code: code ?? 'action_failed', message }, ...extra, ...data });
}

const confirmCard = async (ctx: Ctx, cardId: string, sessionId: string) =>
  okOrThrow((await ctx.api.post('/api/v2/actions/confirm', { card_id: cardId, session_id: sessionId })).data, { session_id: sessionId });

/**
 * A card runs nothing until confirmed. Same rules as confirmSpend: over
 * --max-credits exits 5; --yes confirms; a TTY asks; otherwise exit 7 with
 * the card on stdout and the `actions confirm` command to run after a yes.
 */
async function settleCard(ctx: Ctx, res: ActionResult): Promise<unknown> {
  const card = res.card!;
  const cost = card.credits_required;
  const line = `${card.title}: ${card.summary}${cost == null ? '' : ` Cost: ${cost.toLocaleString()} credits.`}`;
  const max = maxCredits(ctx);
  if (max !== undefined && cost != null && cost > max) {
    throw new CliError(EXIT.CREDITS, `Card costs ${cost} credits, above --max-credits ${max}. Nothing ran.`, 'Raise --max-credits, or narrow the job.', { card: res });
  }
  if (ctx.opts.yes) {
    ctx.log(line);
    return confirmCard(ctx, card.card_id, res.session_id);
  }
  if (interactive(ctx.opts)) {
    ctx.log(line);
    if (await ask('Run it?')) return confirmCard(ctx, card.card_id, res.session_id);
    throw new CliError(EXIT.CONFIRM, 'Cancelled. Nothing ran.');
  }
  throw new CliError(
    EXIT.CONFIRM,
    `Confirmation required: ${line}`,
    `Show this to the user. After they say yes: cleanlist actions confirm ${card.card_id} --session ${res.session_id}`,
    { card: res },
  );
}

export const actionCommands: Command[] = [
  {
    name: 'actions list',
    summary: 'Every Clu action your key and plan can use, with its group and input schema.',
    examples: ['cleanlist actions list', `cleanlist actions list --json | jq '.actions[] | select(.group == "lists") | .name'`],
    view: { rows: (d) => d.actions, columns: ['name', 'group', 'effect', 'card', 'scope', 'title'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/actions')).data;
    },
  },
  {
    name: 'actions run',
    args: '<name>',
    summary: 'Run one action. One that spends, sends, deletes or writes to a CRM returns a card and runs nothing until confirmed.',
    paid: true,
    options: {
      args: { type: 'string', desc: 'Arguments as a JSON object (see `actions list --json` for each input_schema).' },
      session: { type: 'string', desc: 'session_id from an earlier call, to keep the same conversation.' },
    },
    examples: [
      `cleanlist actions run agents.get --args '{"agent_id":"..."}' --json`,
      `cleanlist actions run lists.delete --args '{"list_id":"..."}'   # a card: exit 7 until confirmed`,
    ],
    async run(ctx) {
      const name = requireArg(ctx, 'action name, e.g. agents.get', 'actions list');
      if (ctx.opts['dry-run']) throw new CliError(EXIT.USAGE, '--dry-run is not supported here.', 'Run without --yes: an action that spends or sends returns a card and runs nothing.');
      const body = { arguments: jsonOpt(ctx.opts.args, 'args') ?? {}, session_id: ctx.opts.session };
      const { data } = await ctx.api.post<ActionResult>(`/api/v2/actions/${enc(name)}`, body);
      if (data.kind !== 'card') return okOrThrow(data);
      return { action: data.action, session_id: data.session_id, ...((await settleCard(ctx, data)) as object) };
    },
  },
  {
    name: 'actions confirm',
    args: '<card_id>',
    summary: 'Run a card the user approved. It runs once, with the arguments the server holds.',
    options: { session: { type: 'string', desc: 'session_id the card came with (required).' } },
    examples: ['cleanlist actions confirm <card_id> --session <session_id>'],
    async run(ctx) {
      const cardId = requireArg(ctx, 'card_id');
      if (!ctx.opts.session) throw new CliError(EXIT.USAGE, 'Pass --session, the session_id the card came with.');
      if (ctx.opts['dry-run']) throw new CliError(EXIT.USAGE, '--dry-run is not supported here: confirm runs the card.', 'Run it without --dry-run to run the approved card.');
      // The server doesn't show a card's cost at confirm; `actions run` does, and checks the cap there.
      if (ctx.opts['max-credits'] !== undefined) throw new CliError(EXIT.USAGE, '--max-credits applies at `actions run`, which shows the card\'s cost. Nothing ran.', 'Run `actions run ... --max-credits N --yes` to check the cap and confirm in one step.');
      return confirmCard(ctx, cardId, ctx.opts.session);
    },
  },
];
