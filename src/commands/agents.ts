import { type Command, type Ctx, jsonOpt, liveRun, requireArg } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { waitForRun } from './plays.js';

const enc = encodeURIComponent;
const agentId = (ctx: Ctx) => requireArg(ctx, 'agent id', 'agents list');

/** `--schedule null` removes the schedule; anything else must be a JSON object. */
const schedule = (v: unknown) => (v === 'null' ? null : jsonOpt(v, 'schedule'));

/**
 * GTM agents, as in the portal. Turning one on and running it now go through
 * the route's preview, a quote and `commit: true` (`liveRun`); the key needs
 * the opt-in scope of every send and CRM write its plays can make. Its limits
 * stay a person's to set in the Cleanlist app.
 */
export const agentCommands: Command[] = [
  {
    name: 'agents list',
    summary: 'Your GTM agents, newest first.',
    examples: ['cleanlist agents list', `cleanlist agents list --json | jq '.[] | {id, name, status}'`],
    view: { rows: (d) => d, columns: ['id', 'name', 'status', 'nextRunAt', 'lastRunAt', 'modifiedAt'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/gtm-agents')).data;
    },
  },
  {
    name: 'agents get',
    args: '<agent_id>',
    summary: 'One agent, with its plays and status.',
    examples: ['cleanlist agents get <agent_id> --json'],
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/gtm-agents/${enc(agentId(ctx))}`)).data;
    },
  },
  {
    name: 'agents create',
    summary: 'Create an agent. It starts off, with no play.',
    options: {
      name: { type: 'string', desc: 'Agent name (required).' },
      description: { type: 'string', desc: 'What it is for.' },
      settings: { type: 'string', desc: 'Settings as a JSON object (instructions, skillRefs, knowledge, triggers...). Not limits.' },
    },
    examples: ['cleanlist agents create --name "Inbound follow-up"'],
    async run(ctx) {
      if (!ctx.opts.name) throw new CliError(EXIT.USAGE, 'Pass --name.');
      const body = { name: ctx.opts.name, description: ctx.opts.description, settings: jsonOpt(ctx.opts.settings, 'settings') };
      return (await ctx.api.post('/api/v2/gtm-agents', body)).data;
    },
  },
  {
    name: 'agents update',
    args: '<agent_id>',
    summary: "Change an agent's name, description, settings or schedule. Settings and schedule only change while it is off.",
    options: {
      name: { type: 'string', desc: 'New name.' },
      description: { type: 'string', desc: 'New description.' },
      settings: { type: 'string', desc: 'Settings as a JSON object. Not limits: a person sets the budget.' },
      schedule: { type: 'string', desc: 'Schedule as a JSON object (frequency, time, weekday, timezone), or null to remove it.' },
      play: { type: 'string', desc: 'playbook_id of the play to change, when the agent has several.' },
    },
    examples: ['cleanlist agents update <agent_id> --name "Inbound follow-up v2"', `cleanlist agents update <agent_id> --schedule '{"frequency":"daily","time":"09:00"}'`],
    async run(ctx) {
      const id = agentId(ctx);
      const body: Record<string, unknown> = {
        name: ctx.opts.name,
        description: ctx.opts.description,
        settings: jsonOpt(ctx.opts.settings, 'settings'),
        schedule: ctx.opts.schedule === undefined ? undefined : schedule(ctx.opts.schedule),
      };
      if (Object.values(body).every((v) => v === undefined)) throw new CliError(EXIT.USAGE, 'Pass --name, --description, --settings or --schedule.');
      body.playbook_id = ctx.opts.play;
      return (await ctx.api.request('PATCH', `/api/v2/gtm-agents/${enc(id)}`, { body })).data;
    },
  },
  {
    name: 'agents off',
    args: '<agent_id>',
    summary: 'Turn an agent off: its triggers and schedule stop.',
    examples: ['cleanlist agents off <agent_id>'],
    async run(ctx) {
      return (await ctx.api.post(`/api/v2/gtm-agents/${enc(agentId(ctx))}/status`, { status: 'off' })).data;
    },
  },
  {
    name: 'agents on',
    args: '<agent_id>',
    summary: 'Turn an agent on: its triggers and schedule start. Shows what it can spend, send and write to a CRM, and asks first.',
    paid: true,
    examples: ['cleanlist agents on <agent_id> --dry-run', 'cleanlist agents on <agent_id> --yes'],
    async run(ctx) {
      const id = agentId(ctx);
      return liveRun(ctx, `/api/v2/gtm-agents/${enc(id)}/status`, { status: 'on' }, 'Turn the agent on');
    },
  },
  {
    name: 'agents run',
    args: '<agent_id>',
    summary: "Run an agent's play now. Shows what it can spend, send and write to a CRM, and asks first.",
    paid: true,
    options: {
      play: { type: 'string', desc: "playbook_id of the play to run, when the agent has several." },
      wait: { type: 'boolean', desc: 'Block until the run finishes.' },
      timeout: { type: 'string', desc: 'Give up waiting after this long (default 30m); exit 8.' },
    },
    examples: ['cleanlist agents run <agent_id> --dry-run', 'cleanlist agents run <agent_id> --yes --wait'],
    async run(ctx) {
      const id = agentId(ctx);
      const data = await liveRun(ctx, `/api/v2/gtm-agents/${enc(id)}/runs`, { playbook_id: ctx.opts.play }, 'Run the agent');
      // run_id is null when the run is queued (a CRM cleanup play waits for its scan): nothing to wait on yet.
      return ctx.opts.wait && data?.run_id ? waitForRun(ctx, data.run_id) : data;
    },
  },
  {
    name: 'agents runs',
    args: '<agent_id>',
    summary: "An agent's runs, newest first. `plays results <run_id>` shows one run's records.",
    examples: ['cleanlist agents runs <agent_id>'],
    view: { rows: (d) => d, columns: ['id', 'status', 'recordsTotal', 'recordsCompleted', 'recordsFailed', 'creditsUsed', 'createdAt'] },
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/gtm-agents/${enc(agentId(ctx))}/runs`)).data;
    },
  },
];
