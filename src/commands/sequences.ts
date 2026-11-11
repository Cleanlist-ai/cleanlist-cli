import { type Command, type Ctx, jsonArray, jsonOpt, list, requireArg, resolveList, sendApproved } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const STATUSES = ['launch', 'pause', 'resume'];

const sequenceId = (ctx: Ctx) => requireArg(ctx, 'sequence id', 'sequences list');

export const sequenceCommands: Command[] = [
  {
    name: 'sequences list',
    summary: 'Your email sequences.',
    examples: ['cleanlist sequences list'],
    view: { rows: (d) => d.sequences, columns: ['id', 'name', 'status'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/sequences')).data;
    },
  },
  {
    name: 'sequences get',
    args: '<id>',
    summary: 'One sequence with its steps.',
    examples: ['cleanlist sequences get <id> --json'],
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/sequences/${enc(sequenceId(ctx))}`)).data;
    },
  },
  {
    name: 'sequences edit',
    args: '<id>',
    summary: 'Change a sequence\'s steps, name or how Clu writes. On a launched sequence this publishes a new version.',
    options: {
      changes: { type: 'string', desc: 'Step changes as a JSON array of {op: add, update, delete or reorder, ...}; step ids from `sequences get`.' },
      name: { type: 'string', desc: 'New name.' },
      writing: { type: 'string', desc: 'How Clu writes its emails, as a JSON object.' },
    },
    examples: [
      `cleanlist sequences edit <id> --changes '[{"op":"update","step_id":"<step_id>","fields":{"subject":"Quick question"}}]'`,
      'cleanlist sequences edit <id> --name "Q4 ABM v2"',
    ],
    async run(ctx) {
      const id = sequenceId(ctx);
      const changes = jsonArray(ctx.opts.changes, 'changes');
      const writing = jsonOpt(ctx.opts.writing, 'writing');
      if (!changes && !ctx.opts.name && !writing) throw new CliError(EXIT.USAGE, 'Pass --changes, --name or --writing.');
      const body = { changes, name: ctx.opts.name, writing };
      return (await ctx.api.request('PATCH', `/api/v2/sequences/${enc(id)}`, { body })).data;
    },
  },
  {
    name: 'sequences enroll',
    args: '<id>',
    summary: 'Add leads to a sequence. Into an active sequence this emails people: asks first.',
    paid: true,
    options: {
      leads: { type: 'string', multiple: true, desc: 'Lead ids, comma separated.' },
      list: { type: 'string', desc: 'Every lead in this list (id or exact name).' },
    },
    examples: ['cleanlist sequences enroll <id> --list "Q4 ABM"', 'cleanlist sequences enroll <id> --leads <lead_id>,<lead_id> --yes'],
    async run(ctx) {
      const id = sequenceId(ctx);
      const leadIds = list(ctx.opts.leads);
      if (!leadIds === !ctx.opts.list) throw new CliError(EXIT.USAGE, 'Pass --leads or --list (one of them).');
      const body = leadIds ? { lead_ids: leadIds } : { list_id: await resolveList(ctx, ctx.opts.list) };
      return sendApproved(ctx, `/api/v2/sequences/${enc(id)}/enroll`, body);
    },
  },
  {
    name: 'sequences status',
    args: '<id> <launch|pause|resume>',
    summary: 'Launch, pause or resume a sequence. Launch and resume email people: asks first.',
    examples: ['cleanlist sequences status <id> pause', 'cleanlist sequences status <id> launch --yes'],
    paid: true,
    async run(ctx) {
      const id = sequenceId(ctx);
      const status = ctx.args[1];
      if (!STATUSES.includes(status)) throw new CliError(EXIT.USAGE, `Pass the status: ${STATUSES.join(', ')}.`);
      return sendApproved(ctx, `/api/v2/sequences/${enc(id)}/status`, { status });
    },
  },
];
