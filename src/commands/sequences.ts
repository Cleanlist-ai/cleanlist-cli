import { type Command, type Ctx, jsonArray, jsonOpt, requireArg, resolveList } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { runAction } from './actions.js';

/**
 * Sequences through Clu's own sequence actions (`sequences.*`): reads answer at
 * once; an edit, a launch, pause or resume, and an enroll are cards that run
 * nothing until confirmed, like `actions run`.
 */
const STATUSES: Record<string, string> = { launch: 'activate', pause: 'pause', resume: 'resume' };

const sequenceId = (ctx: Ctx) => requireArg(ctx, 'sequence id', 'sequences list');
const sessionOpt = { session: { type: 'string' as const, desc: 'session_id from an earlier call, to keep the same conversation.' } };

const ADD_STEP = `{"op":"add","step":{"kind":"email","subject":"Quick question","body":"Hi {{lead.first_name}}, ..."},"after_step_id":"<step_id>"}`;

export const sequenceCommands: Command[] = [
  {
    name: 'sequences list',
    summary: 'Your sequences, newest first: status, steps, people in them and sender.',
    options: {
      query: { type: 'string', desc: 'Part of a sequence name.' },
      status: { type: 'string', desc: 'draft, active, paused or archived.' },
    },
    examples: ['cleanlist sequences list', 'cleanlist sequences list --status active --json'],
    async run(ctx) {
      return runAction(ctx, 'sequences.list', { query: ctx.opts.query ?? '', status: ctx.opts.status ?? '' });
    },
  },
  {
    name: 'sequences get',
    args: '<id>',
    summary: 'One sequence: its steps in order with their step ids, sender, schedule and people by status.',
    examples: ['cleanlist sequences get <id> --json'],
    async run(ctx) {
      return runAction(ctx, 'sequences.get', { sequence_id: sequenceId(ctx) });
    },
  },
  {
    name: 'sequences edit',
    args: '<id>',
    summary: "Change a sequence's steps, name or how Clu writes it. On a launched sequence this publishes a new version. Asks first.",
    options: {
      changes: {
        type: 'string',
        desc: 'Step changes, in order, as a JSON array: {op: add, step: {kind: email|wait|call|linkedin|task, ...}, after_step_id?}, {op: update, step_id, subject|body|instructions|wait_days|task_type|writer|skills|note}, {op: delete, step_id} or {op: reorder, step_ids}. Step ids from `sequences get`.',
      },
      name: { type: 'string', desc: 'New name.' },
      writing: { type: 'string', desc: 'How Clu writes its emails, as a JSON object.' },
      ...sessionOpt,
    },
    examples: [
      `cleanlist sequences edit <id> --changes '[{"op":"update","step_id":"<step_id>","subject":"Quick question"}]'`,
      `cleanlist sequences edit <id> --changes '[${ADD_STEP}]'`,
      'cleanlist sequences edit <id> --name "Q4 ABM v2" --yes',
    ],
    async run(ctx) {
      const id = sequenceId(ctx);
      const changes = jsonArray(ctx.opts.changes, 'changes');
      const writing = jsonOpt(ctx.opts.writing, 'writing');
      if (!changes && !ctx.opts.name && !writing) throw new CliError(EXIT.USAGE, 'Pass --changes, --name or --writing.');
      const badAdd = changes?.find((c) => c.op === 'add' && (typeof c.step !== 'object' || c.step === null));
      if (badAdd) throw new CliError(EXIT.USAGE, 'An add change puts the new step under "step".', `e.g. ${ADD_STEP}`);
      return runAction(ctx, 'sequences.edit', { sequence_id: id, changes, name: ctx.opts.name ?? '', writing }, ctx.opts.session);
    },
  },
  {
    name: 'sequences status',
    args: '<id> <launch|pause|resume>',
    summary: 'Launch, pause or resume a sequence. Launch and resume email the people in it: asks first.',
    paid: true,
    options: sessionOpt,
    examples: ['cleanlist sequences status <id> pause', 'cleanlist sequences status <id> launch --yes'],
    async run(ctx) {
      const id = sequenceId(ctx);
      const action = STATUSES[ctx.args[1]];
      if (!action) throw new CliError(EXIT.USAGE, `Pass the status: ${Object.keys(STATUSES).join(', ')}.`);
      return runAction(ctx, 'sequences.set_status', { sequence_id: id, action }, ctx.opts.session);
    },
  },
  {
    name: 'sequences enroll',
    args: '<id>',
    summary: 'Add the people of a list to a sequence (up to 2,500 a card). Into an active sequence this emails them: asks first.',
    paid: true,
    options: { list: { type: 'string', desc: 'The list (id or exact name). Required.' }, ...sessionOpt },
    examples: ['cleanlist sequences enroll <id> --list "Q4 ABM"', 'cleanlist sequences enroll <id> --list "Q4 ABM" --yes'],
    async run(ctx) {
      const id = sequenceId(ctx);
      if (!ctx.opts.list) throw new CliError(EXIT.USAGE, 'Pass --list, the list whose people to add.');
      return runAction(ctx, 'sequences.enroll', { sequence_id: id, list_id: await resolveList(ctx, ctx.opts.list) }, ctx.opts.session);
    },
  },
];
