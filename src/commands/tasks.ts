import { type Command, type Ctx, intOpt } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const STATUSES = ['open', 'due', 'overdue', 'done', 'all'];
const TYPES = ['Call', 'Manual', 'Reply'];

function taskId(ctx: Ctx): string {
  const id = ctx.args[0];
  if (!id) throw new CliError(EXIT.USAGE, 'Pass the task id.', 'See `cleanlist tasks list`.');
  return id;
}

/** Call, manual or reply, in any case; the API takes "Call", "Manual", "Reply". */
function taskType(v: unknown, allowed: string[]): string | undefined {
  if (v === undefined) return undefined;
  const found = allowed.find((t) => t.toLowerCase() === String(v).trim().toLowerCase());
  if (!found) throw new CliError(EXIT.USAGE, `--type must be one of ${allowed.join(', ')}.`);
  return found;
}

const patch = async (ctx: Ctx, body: Record<string, unknown>) =>
  (await ctx.api.request('PATCH', `/api/v2/gtm-tasks/${enc(taskId(ctx))}`, { body })).data;

export const taskCommands: Command[] = [
  {
    name: 'tasks list',
    summary: 'Your sequence tasks (calls, manual steps, replies), as the Tasks page lists them.',
    options: {
      status: { type: 'string', desc: 'open (default), due (today), overdue, done or all.' },
      type: { type: 'string', desc: 'Call, Manual or Reply.' },
      limit: { type: 'string', desc: 'At most this many (default 50, max 200).' },
    },
    examples: ['cleanlist tasks list --status due', 'cleanlist tasks list --type call --json'],
    view: { rows: (d) => d.tasks, columns: ['id', 'type', 'name', 'person', 'company', 'due_date', 'status'] },
    async run(ctx) {
      const status = ctx.opts.status;
      if (status !== undefined && !STATUSES.includes(status)) throw new CliError(EXIT.USAGE, `--status must be one of ${STATUSES.join(', ')}.`);
      const query = { status, task_type: taskType(ctx.opts.type, TYPES), limit: intOpt(ctx.opts.limit, 'limit') };
      return (await ctx.api.get('/api/v2/gtm-tasks', query)).data;
    },
  },
  {
    name: 'tasks get',
    args: '<task_id>',
    summary: 'One task, with its lead and sequence.',
    examples: ['cleanlist tasks get <task_id>'],
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/gtm-tasks/${enc(taskId(ctx))}`)).data;
    },
  },
  {
    name: 'tasks done',
    args: '<task_id>',
    summary: 'Complete a task, as the Tasks page does (logs the CRM activity too).',
    options: {
      outcome: { type: 'string', desc: 'How it went. A call task needs one (e.g. "Connected").' },
      note: { type: 'string', desc: 'A note to keep with it.' },
    },
    examples: ['cleanlist tasks done <task_id> --outcome Connected --note "Demo booked for Tuesday"'],
    async run(ctx) {
      return patch(ctx, { status: 'done', outcome: ctx.opts.outcome, note: ctx.opts.note });
    },
  },
  {
    name: 'tasks skip',
    args: '<task_id>',
    summary: 'Skip a task: it comes back on the next day.',
    examples: ['cleanlist tasks skip <task_id> --reason "Out of office"'],
    options: { reason: { type: 'string', desc: 'Why.' } },
    async run(ctx) {
      return patch(ctx, { status: 'skipped', note: ctx.opts.reason });
    },
  },
  {
    name: 'tasks create',
    summary: 'A task for you on a lead in one of your sequences.',
    options: {
      lead: { type: 'string', desc: 'The lead id (required).' },
      type: { type: 'string', desc: 'Call (default) or Manual.' },
      due: { type: 'string', desc: 'Due day, YYYY-MM-DD (required).' },
      note: { type: 'string', desc: 'What to do.' },
    },
    examples: ['cleanlist tasks create --lead <lead_id> --due 2026-11-12 --note "Call about the pilot"'],
    async run(ctx) {
      if (!ctx.opts.lead) throw new CliError(EXIT.USAGE, 'Pass --lead.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.opts.due ?? '')) throw new CliError(EXIT.USAGE, 'Pass --due as YYYY-MM-DD.');
      const body = { lead_id: ctx.opts.lead, task_type: taskType(ctx.opts.type, ['Call', 'Manual']), due_at: ctx.opts.due, note: ctx.opts.note };
      return (await ctx.api.post('/api/v2/gtm-tasks', body)).data;
    },
  },
];
