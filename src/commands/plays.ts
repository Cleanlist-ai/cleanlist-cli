import { type Command, type Ctx, isTerminal, jsonOpt, liveRun, poll, requireArg } from '../context.js';
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
    summary: 'Plays you can call like a function (webhook-triggered), with the inputs each takes.',
    examples: ['cleanlist plays list', `cleanlist plays list --json | jq '.[] | {playbook_id, inputs}'`],
    view: { rows: (d) => d, columns: ['playbook_id', 'agent_id', 'name', 'inputs'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/plays')).data;
    },
  },
  {
    name: 'plays run',
    args: '<playbook_id>',
    summary: 'Run a play on one record made of --inputs, as its webhook would. Shows what it can spend, send and write to a CRM, and asks first.',
    paid: true,
    options: { inputs: { type: 'string', desc: "The play's inputs as a JSON object (see `plays list`)." }, ...waitOpts },
    examples: [`cleanlist plays run <playbook_id> --inputs '{"email":"jane@acme.com"}' --dry-run`, `cleanlist plays run <playbook_id> --inputs '{"email":"jane@acme.com"}' --yes --wait`],
    async run(ctx) {
      const id = requireArg(ctx, 'playbook_id', 'plays list');
      const inputs = jsonOpt(ctx.opts.inputs, 'inputs') ?? {};
      const data = await liveRun(ctx, `/api/v2/plays/${enc(id)}/runs`, { inputs }, 'Run the play');
      if (data?.queued) ctx.log(`Queued behind a run in progress. See which run takes it: cleanlist plays event ${id} ${data.event_id}`);
      // run_id is null while the record waits behind a run in progress: nothing to wait on yet.
      if (!ctx.opts.wait || !data?.run_id) return data;
      return { run: await waitForRun(ctx, data.run_id), records: await records(ctx, data.run_id) };
    },
  },
  {
    name: 'plays event',
    args: '<playbook_id> <event_id>',
    summary: 'A record `plays run` queued: whether a run took it yet, and which.',
    examples: ['cleanlist plays event <playbook_id> <event_id>'],
    async run(ctx) {
      const id = requireArg(ctx, 'playbook_id', 'plays list');
      const eventId = ctx.args[1];
      if (!eventId) throw new CliError(EXIT.USAGE, 'Pass the event_id `plays run` returned.');
      return (await ctx.api.get(`/api/v2/plays/${enc(id)}/events/${enc(eventId)}`)).data;
    },
  },
  {
    name: 'plays results',
    args: '<run_id>',
    summary: 'Status and records of a play or agent run, with what each step wrote.',
    options: {
      limit: { type: 'string', desc: 'Records per page (max 500, default 100).' },
      cursor: { type: 'string', desc: "Next page: the last answer's records.nextCursor." },
      ...waitOpts,
    },
    examples: ['cleanlist plays results <run_id> --wait', 'cleanlist plays results <run_id> --limit 500 --json > run.json'],
    async run(ctx) {
      const id = requireArg(ctx, 'run_id', 'agents runs <agent_id>');
      const run = ctx.opts.wait ? await waitForRun(ctx, id) : (await ctx.api.get(`/api/v2/gtm-runs/${enc(id)}`)).data;
      return { run, records: await records(ctx, id) };
    },
  },
];
