import { type Command, confirmSpend, type Ctx, intOpt, jsonOpt, list, readInput } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import type { View } from '../output.js';

const enc = encodeURIComponent;

/** Rows from a data pull, whichever key the route uses, or from a task read-back. */
const ROW_KEYS = ['results', 'postings', 'job_changes', 'posts', 'engagers', 'companies', 'signals', 'meetings', 'people', 'groups', 'rows'];
const rowsOf = (d: any): any[] => {
  for (const k of ROW_KEYS) if (Array.isArray(d?.[k])) return d[k];
  return [];
};
const view = (columns?: string[]): View => ({ rows: rowsOf, columns });

/** Values from repeated/comma flags plus a file (or - for stdin), one per line; the first CSV column is used. */
function values(ctx: Ctx, flag: string, fileFlag: string, split = true): string[] | undefined {
  const out = [...(list(ctx.opts[flag], split) ?? [])];
  if (ctx.opts[fileFlag]) {
    for (const line of readInput(ctx.opts[fileFlag]).split(/\r?\n/)) {
      const v = line.split(',')[0].trim().replace(/^"|"$/g, '');
      if (v && !/^(domain|email|linkedin_url|lead_id|url)$/i.test(v)) out.push(v);
    }
  }
  const uniq = [...new Set(out)];
  return uniq.length ? uniq : undefined;
}

const domainsOf = (ctx: Ctx) =>
  values(ctx, 'company-domain', 'domains-file')?.map((d) => d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase());

function companyCriteria(ctx: Ctx): Record<string, unknown> | undefined {
  const v = ctx.opts['company-criteria'];
  if (v === undefined) return undefined;
  // Inline JSON or a file / stdin holding it.
  return jsonOpt(String(v).trim().startsWith('{') ? v : readInput(v), 'company-criteria');
}

/**
 * Big pulls answer with a task handle instead of rows. The task read-back is
 * MCP-only, so people pulls point at the CLI's own path: save into a list.
 */
function withRows(ctx: Ctx, data: any, people = false): any {
  if (data?.task_id && !rowsOf(data).length) {
    ctx.log(`Started as task ${data.task_id}.${people ? ` Save the people: cleanlist lists add <list> --from-task ${data.task_id}` : ''}`);
  }
  return data;
}

const limitOpt = (dflt: number, max: number) => ({ limit: { type: 'string' as const, desc: `How many (default ${dflt}, up to ${max}).` } });

function limitOf(ctx: Ctx, dflt: number, max: number): number {
  const n = intOpt(ctx.opts.limit, 'limit') ?? dflt;
  if (n < 1 || n > max) throw new CliError(EXIT.USAGE, `--limit must be 1 to ${max}.`);
  return n;
}

const criteriaOpts = {
  'company-domain': { type: 'string' as const, multiple: true, desc: 'Company domain, e.g. acme.com (repeatable or comma separated).' },
  'domains-file': { type: 'string' as const, desc: 'File (or -) with one company domain per line; the first CSV column is used.' },
  'company-criteria': { type: 'string' as const, desc: 'Company filters as JSON, or a JSON file (or -), as in `search companies`.' },
};

const MEETING_COLUMNS = ['meeting_id', 'title', 'started_at', 'source', 'account_domain', 'attendees'];

export const dataCommands: Command[] = [
  {
    name: 'jobs search',
    summary: 'Find open job postings by title, keyword, company and location. Paid: shows a quote first.',
    paid: true,
    options: {
      title: { type: 'string', multiple: true, desc: 'Job title in the posting (repeatable).' },
      keyword: { type: 'string', multiple: true, desc: 'Keyword in the posting (repeatable).' },
      location: { type: 'string', multiple: true, desc: 'Posting location (repeatable).' },
      'posted-within-days': { type: 'string', desc: 'Only postings from the last N days.' },
      ...criteriaOpts,
      ...limitOpt(25, 1000),
    },
    view: view(['title', 'company_name', 'company_domain', 'location', 'posted_at', 'url']),
    examples: [
      'cleanlist jobs search --title "Head of RevOps" --posted-within-days 30 --limit 50 --yes',
      'cut -d, -f1 accounts.csv | cleanlist jobs search --domains-file - --keyword salesforce --format csv',
    ],
    async run(ctx) {
      const body = {
        titles: list(ctx.opts.title, false),
        keywords: list(ctx.opts.keyword, false),
        company_domains: domainsOf(ctx),
        company_criteria: companyCriteria(ctx),
        locations: list(ctx.opts.location, false),
        posted_within_days: intOpt(ctx.opts['posted-within-days'], 'posted-within-days'),
        limit: limitOf(ctx, 25, 1000),
      };
      if (!body.titles && !body.keywords && !body.company_domains && !body.company_criteria) {
        throw new CliError(EXIT.USAGE, 'Add --title, --keyword, --company-domain or --company-criteria.', 'See `cleanlist jobs search --help`.');
      }
      const q = await confirmSpend(ctx, { tool: 'job_postings_search', row_count: body.limit }, 'Job postings search');
      const { data } = await ctx.api.post('/api/v2/jobs/search', { ...body, quote_id: q.quote_id });
      return withRows(ctx, data);
    },
  },
  {
    name: 'job-changes list',
    summary: 'People in your lists who changed jobs. Free.',
    options: {
      since: { type: 'string', desc: 'Only changes detected after this ISO date, e.g. 2026-11-01.' },
      list: { type: 'string', desc: 'Only people in this list (id).' },
    },
    view: view(['full_name', 'previous_company', 'new_company', 'new_title', 'detected_at', 'linkedin_url']),
    async run(ctx) {
      return (await ctx.api.get('/api/v2/job-changes', { since: ctx.opts.since, list_id: ctx.opts.list })).data;
    },
  },
  {
    name: 'job-changes check',
    summary: 'Check people for a job change now, by lead id or LinkedIn URL. Paid: shows a quote first.',
    paid: true,
    options: {
      lead: { type: 'string', multiple: true, desc: 'Lead id (repeatable or comma separated).' },
      linkedin: { type: 'string', multiple: true, desc: 'LinkedIn profile URL (repeatable or comma separated).' },
      file: { type: 'string', desc: 'File (or -) with one LinkedIn URL per line; the first CSV column is used.' },
    },
    view: view(['full_name', 'changed', 'previous_company', 'new_company', 'new_title', 'linkedin_url']),
    examples: ['cleanlist job-changes check --linkedin https://linkedin.com/in/jane --yes', 'cat champions.txt | cleanlist job-changes check --file - --format jsonl'],
    async run(ctx) {
      const leadIds = list(ctx.opts.lead);
      const urls = values(ctx, 'linkedin', 'file');
      if (!leadIds === !urls) throw new CliError(EXIT.USAGE, 'Pass --lead or --linkedin/--file (one kind, not both).');
      const n = (leadIds ?? urls!).length;
      const q = await confirmSpend(ctx, { tool: 'job_change_check', row_count: n }, 'Job change check');
      const { data } = await ctx.api.post('/api/v2/job-changes/check', { lead_ids: leadIds, linkedin_urls: urls, quote_id: q.quote_id });
      return withRows(ctx, data, true);
    },
  },
  {
    name: 'linkedin posts',
    args: '<topic>',
    summary: 'Recent LinkedIn posts on a topic, through your connected LinkedIn account. Free.',
    options: {
      account: { type: 'string', desc: 'Your LinkedIn account id, when you have more than one connected.' },
      days: { type: 'string', desc: 'How recent: 1, 7 (default) or 30.' },
      ...limitOpt(10, 20),
    },
    view: view(['author', 'author_headline', 'posted', 'reactions', 'comments', 'url']),
    examples: ['cleanlist linkedin posts "cold email reply rates" --days 30'],
    async run(ctx) {
      const keywords = ctx.args.join(' ').trim();
      if (!keywords) throw new CliError(EXIT.USAGE, 'Name the topic, e.g. cleanlist linkedin posts "revops hiring".');
      const days = intOpt(ctx.opts.days, 'days') ?? 7;
      if (![1, 7, 30].includes(days)) throw new CliError(EXIT.USAGE, '--days must be 1, 7 or 30.');
      return (await ctx.api.post('/api/v2/linkedin/posts/search', { keywords, days, limit: limitOf(ctx, 10, 20), account_id: ctx.opts.account })).data;
    },
  },
  {
    name: 'linkedin engagers',
    args: '<post_url>',
    summary: 'People who reacted to or commented on a LinkedIn post. Paid: shows a quote first.',
    paid: true,
    options: {
      kinds: { type: 'string', multiple: true, desc: 'reactions, comments or both (default both).' },
      ...limitOpt(100, 1000),
    },
    view: view(['full_name', 'title', 'company', 'kind', 'linkedin_url']),
    examples: ['cleanlist linkedin engagers https://www.linkedin.com/posts/jane_activity-123 --kinds comments --yes'],
    async run(ctx) {
      const postUrl = ctx.args[0];
      if (!postUrl || !/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(postUrl)) throw new CliError(EXIT.USAGE, 'Pass the LinkedIn post URL (https://www.linkedin.com/...).');
      const kinds = list(ctx.opts.kinds) ?? ['reactions', 'comments'];
      const bad = kinds.filter((k) => !['reactions', 'comments'].includes(k));
      if (bad.length) throw new CliError(EXIT.USAGE, `--kinds takes reactions and comments, not ${bad.join(', ')}.`);
      const limit = limitOf(ctx, 100, 1000);
      const q = await confirmSpend(ctx, { tool: 'post_engagers', row_count: limit }, 'Post engagers');
      const { data } = await ctx.api.post('/api/v2/linkedin/posts/engagers', { post_url: postUrl, kinds, limit, quote_id: q.quote_id });
      return withRows(ctx, data, true);
    },
  },
  {
    name: 'companies tech',
    summary: 'Companies that use a tool or technology. Paid: shows a quote first.',
    paid: true,
    options: {
      tool: { type: 'string', multiple: true, desc: 'Tool or technology, e.g. Salesforce (repeatable or comma separated).' },
      'company-criteria': criteriaOpts['company-criteria'],
      ...limitOpt(25, 1000),
    },
    view: view(['name', 'domain', 'industry', 'employees', 'country', 'tools']),
    examples: ['cleanlist companies tech --tool Outreach,Salesloft --limit 100 --yes --format csv > accounts.csv'],
    async run(ctx) {
      const tools = list(ctx.opts.tool);
      if (!tools) throw new CliError(EXIT.USAGE, 'Pass --tool, e.g. --tool Salesforce.');
      const limit = limitOf(ctx, 25, 1000);
      const q = await confirmSpend(ctx, { tool: 'companies_by_technology', row_count: limit }, 'Companies by technology');
      const { data } = await ctx.api.post('/api/v2/companies/by-technology', { tools, company_criteria: companyCriteria(ctx), limit, quote_id: q.quote_id });
      return withRows(ctx, data);
    },
  },
  {
    name: 'companies signals',
    summary: 'Buying signals (hiring, funding and the other registered signals) for companies. Paid: shows a quote first.',
    paid: true,
    options: {
      type: { type: 'string', multiple: true, desc: 'Signal type (repeatable or comma separated). Omit for every type.' },
      since: { type: 'string', desc: 'Only signals after this ISO date.' },
      ...criteriaOpts,
      ...limitOpt(25, 1000),
    },
    view: view(['company_domain', 'signal_type', 'title', 'detected_at', 'url']),
    examples: ['cleanlist companies signals --company-domain acme.com --since 2026-10-01 --yes', 'cleanlist companies signals --domains-file accounts.csv --type job_postings --format jsonl --yes'],
    async run(ctx) {
      const domains = domainsOf(ctx);
      const criteria = companyCriteria(ctx);
      if (!domains && !criteria) throw new CliError(EXIT.USAGE, 'Pass --company-domain, --domains-file or --company-criteria.');
      const limit = limitOf(ctx, 25, 1000);
      const q = await confirmSpend(ctx, { tool: 'company_signals', row_count: domains?.length ?? limit }, 'Company signals');
      const { data } = await ctx.api.post('/api/v2/companies/signals', {
        signal_types: list(ctx.opts.type),
        company_domains: domains,
        company_criteria: criteria,
        since: ctx.opts.since,
        limit,
        quote_id: q.quote_id,
      });
      return withRows(ctx, data);
    },
  },
  {
    name: 'companies committee',
    args: '<domain>',
    summary: 'The buying committee at a company, by persona. Free.',
    options: { persona: { type: 'string', multiple: true, desc: 'Persona or role group, e.g. "Sales leadership" (repeatable).' } },
    view: { rows: (d) => (d.groups ?? []).flatMap((g: any) => (g.people ?? []).map((p: any) => ({ group: g.label, ...p }))), columns: ['group', 'full_name', 'title', 'in_crm', 'linkedin_url'] },
    examples: ['cleanlist companies committee acme.com --persona "Sales leadership" --persona RevOps'],
    async run(ctx) {
      const company = ctx.args[0];
      if (!company) throw new CliError(EXIT.USAGE, 'Pass the company domain, e.g. acme.com.');
      const { data } = await ctx.api.post('/api/v2/companies/buying-committee', { company, personas: list(ctx.opts.persona, false) });
      if (data?.crm_note) ctx.log(data.crm_note);
      return data;
    },
  },
  {
    name: 'companies org',
    args: '<domain>',
    summary: 'A company\'s org structure: departments, leaders and headcount. Free.',
    async run(ctx) {
      const company = ctx.args[0];
      if (!company) throw new CliError(EXIT.USAGE, 'Pass the company domain, e.g. acme.com.');
      return (await ctx.api.get('/api/v2/companies/org-structure', { company })).data;
    },
  },
  {
    name: 'meetings list',
    summary: 'Meetings and calls from your connected Gong, Fireflies and calendars. Free.',
    options: {
      since: { type: 'string', desc: 'Only meetings after this ISO date.' },
      account: { type: 'string', desc: 'Only meetings with this company domain.' },
      person: { type: 'string', desc: 'Only meetings with this attendee email.' },
    },
    view: view(MEETING_COLUMNS),
    async run(ctx) {
      return (await ctx.api.get('/api/v2/meetings', { since: ctx.opts.since, account_domain: ctx.opts.account, person_email: ctx.opts.person })).data;
    },
  },
  {
    name: 'meetings read',
    args: '<meeting_id>',
    summary: 'One meeting: summary, attendees, notes, and the transcript when the connector has one. Free.',
    async run(ctx) {
      const id = ctx.args[0];
      if (!id) throw new CliError(EXIT.USAGE, 'Pass the meeting_id.', 'See `cleanlist meetings list`.');
      return (await ctx.api.get(`/api/v2/meetings/${enc(id)}`)).data;
    },
  },
];
