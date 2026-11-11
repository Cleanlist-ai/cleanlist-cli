import { type Command, type Ctx, isTerminal, jsonOpt, poll, spend } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;

/** Wait for a play run (an agent run is a play run) to finish. */
export function waitForRun(ctx: Ctx, runId: string) {
  return poll(
    ctx,
    async () => (await ctx.api.get(`/api/v2/gtm-runs/${enc(runId)}`)).data,
    (d: any) => isTerminal(d.status),
    `cleanlist plays results ${runId} --wait`,
    (d: any) => `Run ${d.status}.`,
  );
}

async function records(ctx: Ctx, runId: string) {
  return (await ctx.api.get(`/api/v2/gtm-runs/${enc(runId)}/records`, { limit: ctx.opts.limit, cursor: ctx.opts.cursor, include: 'outputs' })).data;
}

const waitOpts = {
  wait: { type: 'boolean' as const, desc: 'Block until the run finishes, then print its records.' },
  timeout: { type: 'string' as const, desc: 'Give up waiting after this long (default 30m); exit 8.' },
};

export const playCommands: Command[] = [
  {
    name: 'plays list',
    summary: 'Plays you can call like a function, with the inputs each takes.',
    view: { rows: (d) => d, columns: ['playbook_id', 'agent_id', 'name', 'inputs'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/plays')).data;
    },
  },
  {
    name: 'plays run',
    args: '<playbook_id>',
    summary: 'Run a play on one input. Paid: shows a quote first.',
    paid: true,
    options: { inputs: { type: 'string', desc: 'The play\'s inputs as a JSON object (see `plays list`).' }, ...waitOpts },
    examples: [`cleanlist plays run <playbook_id> --inputs '{"email":"jane@acme.com"}' --yes --wait`],
    async run(ctx) {
      const id = ctx.args[0];
      if (!id) throw new CliError(EXIT.USAGE, 'Pass the playbook_id.', 'See `cleanlist plays list`.');
      const inputs = jsonOpt(ctx.opts.inputs, 'inputs') ?? {};
      const { data } = await spend(ctx, { tool: 'run_play', playbook_id: id, row_count: 1 }, 'Run play', (quote_id) =>
        ctx.api.post(`/api/v2/plays/${enc(id)}/run`, { inputs, quote_id }),
      );
      // run_id is null when the run is queued behind one in progress: nothing to wait on yet.
      if (!ctx.opts.wait || !data.run_id) return data;
      return { run: await waitForRun(ctx, data.run_id), records: await records(ctx, data.run_id) };
    },
  },
  {
    name: 'plays results',
    args: '<run_id>',
    summary: 'Status and records of a play or agent run.',
    options: { limit: { type: 'string', desc: 'Records per page (max 500).' }, cursor: { type: 'string', desc: 'Next page: the last answer\'s records.nextCursor.' }, ...waitOpts },
    async run(ctx) {
      const id = ctx.args[0];
      if (!id) throw new CliError(EXIT.USAGE, 'Pass the run_id.');
      const run = ctx.opts.wait ? await waitForRun(ctx, id) : (await ctx.api.get(`/api/v2/gtm-runs/${enc(id)}`)).data;
      return { run, records: await records(ctx, id) };
    },
  },
];
