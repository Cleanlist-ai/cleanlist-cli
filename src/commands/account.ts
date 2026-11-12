import { Api } from '../api.js';
import { type Credential, deleteCredential, loadConfig, loadCredential, removeProfile, saveCredential, saveProfile } from '../config.js';
import { type Command, confirmSpend, DryRun, intOpt, list, readKey, resolveList } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { loginDevice, loginLoopback, revoke } from '../oauth.js';

export const accountCommands: Command[] = [
  {
    name: 'login',
    summary: 'Sign in and save a credential for this profile (one profile = one workspace).',
    noAuth: true,
    options: {
      device: { type: 'boolean', desc: 'Sign in with a code on another device (SSH, no browser).' },
    },
    examples: [
      'cleanlist login',
      'cleanlist login --device',
      'cleanlist login --api-key -                     # paste the key at a hidden prompt',
      'cleanlist login --profile acme                 # a second workspace',
    ],
    async run(ctx) {
      let cred: Credential;
      const key = ctx.opts['api-key'];
      if (key) {
        const value = await readKey(key);
        if (!value.startsWith('clapi_')) throw new CliError(EXIT.USAGE, 'That is not a Cleanlist API key (they start with clapi_).');
        cred = { type: 'api_key', key: value };
      } else {
        cred = ctx.opts.device ? await loginDevice() : await loginLoopback();
      }
      // Check the credential works and learn which workspace it acts in.
      const me = (await new Api(ctx.apiUrl, cred, ctx.profile, false).get('/api/v2/whoami')).data;
      saveCredential(ctx.profile, cred);
      saveProfile(
        ctx.profile,
        {
          apiUrl: ctx.apiUrl,
          organizationId: me.organization_id,
          organizationName: me.organization_name ?? undefined,
          email: me.user_email ?? undefined,
          authType: cred.type,
        },
        !loadConfig().defaultProfile,
      );
      ctx.log(`Signed in to ${me.organization_name ?? me.organization_id} as ${me.user_email ?? me.user_id} (profile "${ctx.profile}").`);
      return { profile: ctx.profile, organization_id: me.organization_id, organization_name: me.organization_name, user_email: me.user_email, auth_type: cred.type };
    },
  },
  {
    name: 'logout',
    summary: 'Delete this profile\'s saved credential (and revoke it, for browser sign-in).',
    noAuth: true,
    async run(ctx) {
      const cred = loadCredential(ctx.profile);
      if (cred?.type === 'oauth') await revoke(cred);
      deleteCredential(ctx.profile);
      removeProfile(ctx.profile);
      ctx.log(
        cred?.type === 'api_key'
          ? `Removed profile "${ctx.profile}". The API key still works until you revoke it in Settings → API keys.`
          : `Signed out of profile "${ctx.profile}".`,
      );
      return { profile: ctx.profile, removed: Boolean(cred) };
    },
  },
  {
    name: 'whoami',
    summary: 'Show the workspace, user, plan and scopes this credential acts as.',
    examples: ['cleanlist whoami', 'cleanlist whoami --json | jq .organization_name'],
    async run(ctx) {
      return (await ctx.api.get('/api/v2/whoami')).data;
    },
  },
  {
    name: 'profiles',
    summary: 'List saved profiles (workspaces) on this machine.',
    noAuth: true,
    view: { rows: (d) => d.profiles, columns: ['name', 'default', 'organization_name', 'email', 'auth_type', 'api_url'] },
    async run() {
      const cfg = loadConfig();
      return {
        profiles: Object.entries(cfg.profiles).map(([name, p]) => ({
          name,
          default: name === cfg.defaultProfile,
          organization_name: p.organizationName,
          organization_id: p.organizationId,
          email: p.email,
          auth_type: p.authType,
          api_url: p.apiUrl,
        })),
      };
    },
  },
  {
    name: 'credits',
    summary: 'Show the workspace credit balance.',
    examples: ['cleanlist credits', 'cleanlist credits --json | jq .credits'],
    async run(ctx) {
      return (await ctx.api.get('/api/v2/credits/balance')).data;
    },
  },
  {
    name: 'credits estimate',
    args: '<tool>',
    summary: 'Get a signed price quote without spending anything (tools: enrich_list, run_smart_agent, add_person_enrichments, enrich_person, ...).',
    options: {
      list: { type: 'string', desc: 'List id or exact name; row count comes from the list.' },
      scope: { type: 'string', desc: 'enrich_list scope: partial | full | phone-only.' },
      rows: { type: 'string', desc: 'Row count, when there is no list.' },
      'agent-type': { type: 'string', desc: 'run_smart_agent agent type.' },
      task: { type: 'string', desc: 'Search task id, for cohort tools.' },
      data: { type: 'string', multiple: true, desc: 'Data points for cohort tools: Email, Phone, LinkedIn.' },
    },
    examples: ['cleanlist credits estimate enrich_list --list "Q4 ABM" --scope full'],
    async run(ctx) {
      const tool = ctx.args[0];
      if (!tool) throw new CliError(EXIT.USAGE, 'Name the tool to price, e.g. enrich_list.');
      const body = {
        tool,
        list_id: ctx.opts.list ? await resolveList(ctx, ctx.opts.list) : undefined,
        scope: ctx.opts.scope,
        row_count: intOpt(ctx.opts.rows, 'rows'),
        agent_type: ctx.opts['agent-type'],
        task_id: ctx.opts.task,
        data_points: list(ctx.opts.data),
      };
      try {
        await confirmSpend({ ...ctx, opts: { ...ctx.opts, 'dry-run': true } }, body, tool);
      } catch (e) {
        if (e instanceof DryRun) return e.output;
        throw e;
      }
    },
  },
  {
    name: 'usage',
    summary: 'API usage report: calls, credits spent and errors, grouped by tool or day.',
    options: {
      days: { type: 'string', desc: 'Look-back window in days (default 30).' },
      'group-by': { type: 'string', desc: 'tool | day | key.' },
    },
    view: { rows: (d) => d.rows, columns: ['group', 'calls', 'credits_spent', 'errors'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/usage', { days: ctx.opts.days, group_by: ctx.opts['group-by'] })).data;
    },
  },
];
