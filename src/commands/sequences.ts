import { type Command, type Ctx, list, resolveList, sendApproved } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const STATUSES = ['launch', 'pause', 'resume'];

function sequenceId(ctx: Ctx): string {
  const id = ctx.args[0];
  if (!id) throw new CliError(EXIT.USAGE, 'Pass the sequence id.', 'See `cleanlist sequences list`.');
  return id;
}

export const sequenceCommands: Command[] = [
  {
    name: 'sequences list',
    summary: 'Your email sequences.',
    view: { rows: (d) => d.sequences, columns: ['id', 'name', 'status'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/sequences')).data;
    },
  },
  {
    name: 'sequences get',
    args: '<id>',
    summary: 'One sequence with its steps.',
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/sequences/${enc(sequenceId(ctx))}`)).data;
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
    paid: true,
    async run(ctx) {
      const id = sequenceId(ctx);
      const status = ctx.args[1];
      if (!STATUSES.includes(status)) throw new CliError(EXIT.USAGE, `Pass the status: ${STATUSES.join(', ')}.`);
      return sendApproved(ctx, `/api/v2/sequences/${enc(id)}/status`, { status });
    },
  },
];
