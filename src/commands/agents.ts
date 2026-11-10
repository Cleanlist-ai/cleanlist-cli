import { type Command, confirmSpend, type Ctx, jsonOpt } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { waitForRun } from './plays.js';

const enc = encodeURIComponent;
const AGENT_COLUMNS = ['agent_id', 'name', 'status'];

function agentId(ctx: Ctx): string {
  const id = ctx.args[0];
  if (!id) throw new CliError(EXIT.USAGE, 'Pass the agent_id.', 'See `cleanlist agents list`.');
  return id;
}

const setStatus = (status: 'on' | 'off'): Command => ({
  name: `agents ${status}`,
  args: '<agent_id>',
  summary: status === 'on' ? 'Turn an agent on: its triggers and schedule start running.' : 'Turn an agent off.',
  async run(ctx) {
    return (await ctx.api.post(`/api/v2/gtm-agents/${enc(agentId(ctx))}/status`, { status })).data;
  },
});

export const agentCommands: Command[] = [
  {
    name: 'agents list',
    summary: 'Your GTM agents.',
    view: { rows: (d) => d.agents, columns: AGENT_COLUMNS },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/gtm-agents')).data;
    },
  },
  {
    name: 'agents get',
    args: '<agent_id>',
    summary: 'One agent, with its plays and status.',
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
      const q = await confirmSpend(ctx, { tool: 'run_gtm_agent', agent_id: id, playbook_id: playbookId }, 'Run agent');
      const { data } = await ctx.api.post(`/api/v2/gtm-agents/${enc(id)}/run`, { playbook_id: playbookId, quote_id: q.quote_id });
      return ctx.opts.wait ? waitForRun(ctx, data.run_id) : data;
    },
  },
  {
    name: 'agents runs',
    args: '<agent_id>',
    summary: 'An agent\'s runs. `plays results <run_id>` shows one run\'s records.',
    view: { rows: (d) => d.runs, columns: ['run_id', 'status', 'records_total', 'records_completed', 'credits_used', 'created_at'] },
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/gtm-agents/${enc(agentId(ctx))}/runs`)).data;
    },
  },
];
