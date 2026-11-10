import { ask, type Command, type Ctx, interactive, jsonOpt } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;

interface ActionResult {
  action: string;
  session_id: string;
  kind: 'result' | 'card';
  result?: unknown;
  card?: { card_id: string; title: string; summary: string; credits_required: number; expires_at: string };
}

const confirmCard = async (ctx: Ctx, cardId: string, sessionId: string) =>
  (await ctx.api.post('/api/v2/actions/confirm', { card_id: cardId, session_id: sessionId })).data;

/**
 * A card runs nothing until confirmed. Same rules as confirmSpend: over
 * --max-credits exits 5; --yes confirms; a TTY asks; otherwise exit 7 with
 * the card on stdout and the `actions confirm` command to run after a yes.
 */
async function settleCard(ctx: Ctx, res: ActionResult): Promise<unknown> {
  const card = res.card!;
  const line = `${card.title}: ${card.summary} Cost: ${card.credits_required.toLocaleString()} credits.`;
  const max = ctx.opts['max-credits'];
  if (max !== undefined && card.credits_required > Number(max)) {
    throw new CliError(EXIT.CREDITS, `Card costs ${card.credits_required} credits, above --max-credits ${max}. Nothing ran.`, undefined, { card: res });
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
    summary: 'Every Clu action your key and plan can use, with its input schema.',
    view: { rows: (d) => d.actions, columns: ['name', 'group', 'effect', 'card', 'title'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/actions')).data;
    },
  },
  {
    name: 'actions run',
    args: '<name>',
    summary: 'Run one action. Actions that spend or send return a card and run nothing until confirmed.',
    paid: true,
    options: {
      args: { type: 'string', desc: 'Arguments as a JSON object (see `actions list --json` for each input_schema).' },
      session: { type: 'string', desc: 'session_id from an earlier call, to keep the same conversation.' },
    },
    examples: [
      `cleanlist actions run agents.get --args '{"agent_id":"..."}' --json`,
      `cleanlist actions run agents.set_status --args '{"agent_id":"...","status":"on"}' --session <session_id>`,
    ],
    async run(ctx) {
      const name = ctx.args[0];
      if (!name) throw new CliError(EXIT.USAGE, 'Pass the action name, e.g. agents.get.', 'See `cleanlist actions list`.');
      if (ctx.opts['dry-run']) throw new CliError(EXIT.USAGE, '--dry-run is not supported here.', 'Run without --yes: an action that spends or sends returns a card and runs nothing.');
      const body = { arguments: jsonOpt(ctx.opts.args, 'args') ?? {}, session_id: ctx.opts.session };
      const { data } = await ctx.api.post<ActionResult>(`/api/v2/actions/${enc(name)}`, body);
      if (data.kind !== 'card') return data;
      return { action: data.action, session_id: data.session_id, ...(await settleCard(ctx, data) as object) };
    },
  },
  {
    name: 'actions confirm',
    args: '<card_id>',
    summary: 'Run a card the user approved. It runs once with the arguments the server holds.',
    options: { session: { type: 'string', desc: 'session_id the card came with (required).' } },
    examples: ['cleanlist actions confirm <card_id> --session <session_id>'],
    async run(ctx) {
      const cardId = ctx.args[0];
      if (!cardId) throw new CliError(EXIT.USAGE, 'Pass the card_id.');
      if (!ctx.opts.session) throw new CliError(EXIT.USAGE, 'Pass --session, the session_id the card came with.');
      return confirmCard(ctx, cardId, ctx.opts.session);
    },
  },
];
