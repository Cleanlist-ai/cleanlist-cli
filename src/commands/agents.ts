import { type Command, type Ctx, jsonOpt, requireArg, spend } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { waitForRun } from './plays.js';

const enc = encodeURIComponent;
const AGENT_COLUMNS = ['id', 'name', 'status', 'playIds', 'modifiedAt'];

const agentId = (ctx: Ctx) => requireArg(ctx, 'agent id', 'agents list');

const setStatus = (status: 'on' | 'off'): Command => ({
  name: `agents ${status}`,
  args: '<agent_id>',
  summary: status === 'on' ? 'Turn an agent on: its triggers and schedule start running.' : 'Turn an agent off.',
  examples: [`cleanlist agents ${status} <agent_id>`],
  async run(ctx) {
    return (await ctx.api.post(`/api/v2/gtm-agents/${enc(agentId(ctx))}/status`, { status })).data;
  },
});

export const agentCommands: Command[] = [
  {
    name: 'agents list',
    summary: 'Your GTM agents.',
    examples: ['cleanlist agents list'],
    view: { rows: (d) => d, columns: AGENT_COLUMNS },
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
    summary: 'Create an agent. It starts off.',
    options: {
      name: { type: 'string', desc: 'Agent name (required).' },
      description: { type: 'string', desc: 'What it is for.' },
      settings: { type: 'string', desc: 'Settings as a JSON object.' },
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
    summary: 'Change an agent\'s name, settings or schedule.',
    examples: ['cleanlist agents update <agent_id> --name "Inbound follow-up v2"'],
    options: {
      name: { type: 'string', desc: 'New name.' },
      settings: { type: 'string', desc: 'Settings as a JSON object.' },
      schedule: { type: 'string', desc: 'Schedule as a JSON object.' },
    },
    async run(ctx) {
      const id = agentId(ctx);
      const body = { name: ctx.opts.name, settings: jsonOpt(ctx.opts.settings, 'settings'), schedule: jsonOpt(ctx.opts.schedule, 'schedule') };
      if (Object.values(body).every((v) => v === undefined)) throw new CliError(EXIT.USAGE, 'Pass --name, --settings or --schedule.');
      return (await ctx.api.request('PATCH', `/api/v2/gtm-agents/${enc(id)}`, { body })).data;
    },
  },
  setStatus('on'),
  setStatus('off'),
  {
    name: 'agents run',
    args: '<agent_id>',
    summary: 'Run an agent now. Paid: shows a quote first.',
    paid: true,
    options: {
      play: { type: 'string', desc: 'playbook_id of the play to run (default: the agent\'s play).' },
      wait: { type: 'boolean', desc: 'Block until the run finishes.' },
      timeout: { type: 'string', desc: 'Give up waiting after this long (default 30m); exit 8.' },
    },
    examples: ['cleanlist agents run <agent_id> --dry-run', 'cleanlist agents run <agent_id> --yes --wait'],
    async run(ctx) {
      const id = agentId(ctx);
      const playbookId = ctx.opts.play;
      const { data } = await spend(ctx, { tool: 'run_gtm_agent', agent_id: id, playbook_id: playbookId }, 'Run agent', (quote_id) =>
        ctx.api.post(`/api/v2/gtm-agents/${enc(id)}/run`, { playbook_id: playbookId, quote_id }),
      );
      // run_id is null when the run is queued behind one in progress: nothing to wait on yet.
      return ctx.opts.wait && data.run_id ? waitForRun(ctx, data.run_id) : data;
    },
  },
  {
    name: 'agents runs',
    args: '<agent_id>',
    summary: 'An agent\'s runs. `plays results <run_id>` shows one run\'s records.',
    examples: ['cleanlist agents runs <agent_id>'],
    view: { rows: (d) => d, columns: ['id', 'status', 'recordsTotal', 'recordsCompleted', 'recordsFailed', 'creditsUsed', 'createdAt'] },
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/gtm-agents/${enc(agentId(ctx))}/runs`)).data;
    },
  },
];
