import { type Command, type Ctx, isTerminal, poll, requireArg } from '../context.js';

const enc = encodeURIComponent;

/** Wait for a play run (an agent run is a play run) to finish. */
function waitForRun(ctx: Ctx, runId: string) {
  return poll(
    ctx,
    async () => (await ctx.api.get(`/api/v2/gtm-runs/${enc(runId)}`)).data,
    (d: any) => isTerminal(d.status),
    `cleanlist plays results ${runId} --wait`,
    (d: any) => `Run ${d.status}.`,
  );
}

export const playCommands: Command[] = [
  {
    name: 'plays results',
    args: '<run_id>',
    summary: "Status and records of a play or agent run, with what each step wrote. Runs start in Cleanlist.",
    options: {
      limit: { type: 'string', desc: 'Records per page (max 500, default 100).' },
      cursor: { type: 'string', desc: "Next page: the last answer's records.nextCursor." },
      wait: { type: 'boolean', desc: 'Block until the run finishes, then print its records.' },
      timeout: { type: 'string', desc: 'Give up waiting after this long (default 30m); exit 8.' },
    },
    examples: ['cleanlist plays results <run_id> --wait', 'cleanlist plays results <run_id> --limit 500 --json > run.json'],
    async run(ctx) {
      const id = requireArg(ctx, 'run_id', 'agents runs <agent_id>');
      const run = ctx.opts.wait ? await waitForRun(ctx, id) : (await ctx.api.get(`/api/v2/gtm-runs/${enc(id)}`)).data;
      const records = (await ctx.api.get(`/api/v2/gtm-runs/${enc(id)}/records`, { limit: ctx.opts.limit, cursor: ctx.opts.cursor, include: 'outputs' })).data;
      return { run, records };
    },
  },
];
