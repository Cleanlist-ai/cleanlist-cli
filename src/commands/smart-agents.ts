import { type Command, type Ctx, confirmSpend, intOpt, isTerminal, poll, resolveList } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const TYPES = ['custom_ai', 'cold_intro_email', 'title_normalizer', 'company_intel', 'pain_point_hypothesis'];

function waitForAgent(ctx: Ctx, id: string) {
  return poll(
    ctx,
    async () => (await ctx.api.get(`/api/v2/smart-agents/${enc(id)}`)).data,
    (d: any) => isTerminal(d.status),
    `cleanlist smart-agents results ${id} --wait`,
    (d: any) => `Agent ${d.status}: ${d.progress ?? 0}/${d.total ?? '?'}.`,
  );
}

const RESULT_VIEW = { rows: (d: any) => d.results, columns: ['lead_id', 'value', 'error'] };

export const smartAgentCommands: Command[] = [
  {
    name: 'smart-agents run',
    args: '<list>',
    summary: 'Run a smart agent (AI column) over a list. Paid: shows a quote first.',
    paid: true,
    options: {
      type: { type: 'string', desc: `Agent: ${TYPES.join(', ')} (default custom_ai).` },
      prompt: { type: 'string', desc: 'Instructions, for custom_ai. Reference fields like {{company}}.' },
      column: { type: 'string', desc: 'Name of the column to write results into.' },
      template: { type: 'string', desc: 'Saved prompt template id.' },
      rows: { type: 'string', desc: 'Only the first N rows.' },
      all: { type: 'boolean', desc: 'Every row in the list.' },
      overwrite: { type: 'boolean', desc: 'Replace existing values in the column.' },
      wait: { type: 'boolean', desc: 'Block until the run finishes.' },
      timeout: { type: 'string', desc: 'Give up waiting after this long (default 30m).' },
    },
    view: RESULT_VIEW,
    examples: [
      'cleanlist smart-agents run "Q4 ABM" --column "Hook" --prompt "One-line opener about {{company}}" --rows 10 --dry-run',
      'cleanlist smart-agents run "Q4 ABM" --type company_intel --column Intel --all --yes --wait',
    ],
    async run(ctx) {
      const type = ctx.opts.type ?? 'custom_ai';
      if (!TYPES.includes(type)) throw new CliError(EXIT.USAGE, `--type must be one of ${TYPES.join(', ')}.`);
      if (!ctx.opts.column) throw new CliError(EXIT.USAGE, 'Pass --column, the name of the column to fill.');
      if (type === 'custom_ai' && !ctx.opts.prompt && !ctx.opts.template) throw new CliError(EXIT.USAGE, 'custom_ai needs --prompt or --template.');
      const listId = await resolveList(ctx, ctx.args[0]);
      const rows = intOpt(ctx.opts.rows, 'rows');
      const body = {
        list_id: listId,
        agent_type: type,
        column_name: ctx.opts.column,
        prompt: ctx.opts.prompt,
        template_id: ctx.opts.template,
        lead_scope: ctx.opts.all ? 'all' : 'subset',
        max_rows: ctx.opts.all ? undefined : rows,
        overwrite: Boolean(ctx.opts.overwrite),
      };
      const q = await confirmSpend(ctx, { tool: 'run_smart_agent', ...body }, `Run ${type}`);
      const { data } = await ctx.api.post('/api/v2/smart-agents/run', { ...body, quote_id: q.quote_id });
      return ctx.opts.wait ? waitForAgent(ctx, data.smart_agent_task_id) : data;
    },
  },
  {
    name: 'smart-agents list',
    summary: 'Recent smart-agent runs.',
    options: { list: { type: 'string', desc: 'Only runs on this list.' }, limit: { type: 'string', desc: 'How many (default 20).' } },
    view: { rows: (d) => d.runs, columns: ['task_id', 'column_name', 'agent_type', 'status', 'processed', 'total', 'created_at'] },
    async run(ctx) {
      const listId = ctx.opts.list ? await resolveList(ctx, ctx.opts.list) : undefined;
      return (await ctx.api.get('/api/v2/smart-agents', { list_id: listId, limit: ctx.opts.limit })).data;
    },
  },
  {
    name: 'smart-agents results',
    args: '<smart_agent_task_id>',
    summary: 'Status and output of a smart-agent run.',
    options: { wait: { type: 'boolean', desc: 'Block until it finishes.' }, timeout: { type: 'string', desc: 'Default 30m.' } },
    view: RESULT_VIEW,
    async run(ctx) {
      const id = ctx.args[0];
      if (!id) throw new CliError(EXIT.USAGE, 'Pass the smart_agent_task_id.');
      return ctx.opts.wait ? waitForAgent(ctx, id) : (await ctx.api.get(`/api/v2/smart-agents/${enc(id)}`)).data;
    },
  },
];
