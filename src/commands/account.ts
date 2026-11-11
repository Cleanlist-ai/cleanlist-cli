import { Api } from '../api.js';
import {
  type Credential,
  deleteCredential,
  loadConfig,
  loadCredential,
  removeProfile,
  saveCredential,
  saveProfile,
  testCredentialName,
  useProfile,
} from '../config.js';
import { type Command, confirmSpend, DryRun, intOpt, list, readKey, requireArg, resolveList } from '../context.js';
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
      'cleanlist login --test --api-key -             # this profile\'s test key, used with --test',
    ],
    async run(ctx) {
      let cred: Credential;
      const key = ctx.opts['api-key'];
      if (key) {
        const value = await readKey(key);
        if (!value.startsWith('clapi_')) throw new CliError(EXIT.USAGE, 'That is not a Cleanlist API key (they start with clapi_).');
        cred = { type: 'api_key', key: value };
      } else if (ctx.test) {
        throw new CliError(EXIT.USAGE, 'Test mode signs in with a test API key.', 'Run `cleanlist login --test --api-key -` and paste a clapi_test_ key (Settings → Developer → Test).');
      } else {
        cred = ctx.opts.device ? await loginDevice() : await loginLoopback();
      }
      const test = cred.type === 'api_key' && cred.key.startsWith('clapi_test_');
      if (ctx.test && !test) throw new CliError(EXIT.USAGE, 'That is a live key; --test needs a clapi_test_ key.');
      // Check the credential works and learn which workspace it acts in.
      const me = (await new Api(ctx.apiUrl, cred, ctx.profile, false).get('/api/v2/whoami')).data;
      if (test) {
        // A test key sits beside the profile's live credential and leaves its workspace details alone.
        saveCredential(testCredentialName(ctx.profile), cred);
        const existing = loadConfig().profiles[ctx.profile];
        saveProfile(ctx.profile, { apiUrl: ctx.apiUrl, ...existing, hasTestKey: true }, !loadConfig().defaultProfile);
        ctx.log(`Saved the test key for profile "${ctx.profile}". Use it with --test or CLEANLIST_MODE=test.`);
        return { profile: ctx.profile, mode: 'test', organization_id: me.organization_id, organization_name: me.organization_name };
      }
      saveCredential(ctx.profile, cred);
      saveProfile(
        ctx.profile,
        {
          apiUrl: ctx.apiUrl,
          organizationId: me.organization_id,
          organizationName: me.organization_name ?? undefined,
          email: me.user_email ?? undefined,
          authType: cred.type,
          hasTestKey: loadConfig().profiles[ctx.profile]?.hasTestKey,
        },
        !loadConfig().defaultProfile,
      );
      ctx.log(`Signed in to ${me.organization_name ?? me.organization_id} as ${me.user_email ?? me.user_id} (profile "${ctx.profile}").`);
      return { profile: ctx.profile, organization_id: me.organization_id, organization_name: me.organization_name, user_email: me.user_email, auth_type: cred.type };
    },
  },
  {
    name: 'logout',
    summary: 'Delete this profile\'s saved credentials (and revoke them, for browser sign-in). --test: only its test key.',
    examples: ['cleanlist logout', 'cleanlist logout --profile acme --test'],
    noAuth: true,
    async run(ctx) {
      const testName = testCredentialName(ctx.profile);
      if (ctx.test) {
        const had = Boolean(loadCredential(testName));
        deleteCredential(testName);
        const existing = loadConfig().profiles[ctx.profile];
        if (existing) saveProfile(ctx.profile, { ...existing, hasTestKey: false }, false);
        ctx.log(`Removed the test key from profile "${ctx.profile}".`);
        return { profile: ctx.profile, mode: 'test', removed: had };
      }
      deleteCredential(testName);
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
    summary: 'List saved profiles (workspaces) on this machine. ACTIVE is the one commands use now.',
    examples: ['cleanlist profiles'],
    noAuth: true,
    view: { rows: (d) => d.profiles, columns: ['name', 'active', 'default', 'organization_name', 'email', 'auth_type', 'test_key', 'api_url'] },
    async run(ctx) {
      const cfg = loadConfig();
      return {
        profiles: Object.entries(cfg.profiles).map(([name, p]) => ({
          name,
          active: name === ctx.profile,
          default: name === cfg.defaultProfile,
          organization_name: p.organizationName,
          organization_id: p.organizationId,
          email: p.email,
          auth_type: p.authType,
          test_key: Boolean(p.hasTestKey),
          api_url: p.apiUrl,
        })),
      };
    },
  },
  {
    name: 'use',
    args: '<profile>',
    summary: 'Switch workspaces: make this saved profile the default.',
    noAuth: true,
    examples: ['cleanlist use acme', 'cleanlist profiles'],
    async run(ctx) {
      const name = requireArg(ctx, 'profile name', 'profiles');
      if (!useProfile(name)) throw new CliError(EXIT.NOT_FOUND, `No profile named "${name}".`, `See \`cleanlist profiles\`, or sign in with \`cleanlist login --profile ${name}\`.`);
      const p = loadConfig().profiles[name];
      ctx.log(`Now using profile "${name}" (${p.organizationName ?? p.organizationId ?? 'workspace'}).`);
      if (process.env.CLEANLIST_PROFILE && process.env.CLEANLIST_PROFILE !== name) {
        ctx.log(`CLEANLIST_PROFILE=${process.env.CLEANLIST_PROFILE} is set and still wins in this shell.`);
      }
      return { profile: name, organization_id: p.organizationId, organization_name: p.organizationName };
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
    examples: ['cleanlist usage --days 7 --group-by day'],
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
