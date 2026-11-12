import { type Command, type Ctx, jsonOpt, requireArg } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const agentId = (ctx: Ctx) => requireArg(ctx, 'agent id', 'agents list');

/** `--schedule null` removes the schedule; anything else must be a JSON object. */
const schedule = (v: unknown) => (v === 'null' ? null : jsonOpt(v, 'schedule'));

/**
 * GTM agents, as in the portal. Turning one on, running it now and setting its
 * limits are a person's to do in the Cleanlist app: the API refuses them from
 * code (403 person_required), so there is no command for them.
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
    summary: 'Create an agent. It starts off, with no play; a person turns it on in Cleanlist.',
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
    summary: 'Turn an agent off: its triggers and schedule stop. Turning one on is done in Cleanlist.',
    examples: ['cleanlist agents off <agent_id>'],
    async run(ctx) {
      return (await ctx.api.post(`/api/v2/gtm-agents/${enc(agentId(ctx))}/status`, { status: 'off' })).data;
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
