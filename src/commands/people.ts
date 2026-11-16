import { type Command, type Ctx, intOpt, list, readInput } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { printRows } from '../output.js';

/** Flag → PeopleSearchCriteria field. Array fields take repeated flags or commas. */
const ARRAY_FLAGS: Record<string, [field: string, splitCommas: boolean, desc: string]> = {
  title: ['jobTitlesInclude', false, 'Job title (repeatable).'],
  'exclude-title': ['jobTitlesExclude', false, 'Job title to exclude (repeatable).'],
  seniority: ['seniority', true, 'Seniority: Owner / Partner, CXO, Vice President, Director, Manager, Senior, Entry, Training.'],
  function: ['functionCategoriesInclude', true, 'Job function: Engineering, Sales, Marketing, Operations, Finance, Human Resources, Product Management, Consulting, Research, Customer Success, Legal, Arts and Design.'],
  industry: ['industriesInclude', false, 'Company industry, repeatable (exact labels: `people filters company_industries <word>`).'],
  'company-size': ['companySizes', false, 'Employees, repeatable: 1-10, 11-50, 51-200, 201-500, 501-1,000, 1,001-5,000, 5,001-10,000, 10,001+.'],
  country: ['contactCountries', true, 'Person country.'],
  region: ['contactRegions', false, 'Person state/region.'],
  city: ['contactCities', false, 'Person city.'],
  'company-country': ['companyCountries', true, 'Company HQ country.'],
  'company-domain': ['currentCompanyDomains', true, 'Current company domain, e.g. acme.com.'],
  company: ['currentCompanyNames', false, 'Current company name (repeatable).'],
  skill: ['skills', false, 'Skill (repeatable).'],
};

const searchOptions = Object.fromEntries(
  Object.entries(ARRAY_FLAGS).map(([flag, [, , desc]]) => [flag, { type: 'string' as const, multiple: true, desc }]),
);

function criteriaFrom(ctx: Ctx): Record<string, unknown> {
  let criteria: Record<string, unknown> = {};
  if (ctx.opts.criteria) {
    try {
      criteria = JSON.parse(readInput(ctx.opts.criteria));
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(EXIT.USAGE, `--criteria is not valid JSON: ${(e as Error).message}`);
    }
  }
  for (const [flag, [field, split]] of Object.entries(ARRAY_FLAGS)) {
    const v = list(ctx.opts[flag], split);
    if (v) criteria[field] = v;
  }
  if (ctx.opts['company-domains-file']) {
    const domains = readInput(ctx.opts['company-domains-file'])
      .split(/\r?\n/)
      .map((l) => l.split(',')[0].trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter((d) => d && d.includes('.'));
    criteria.currentCompanyDomains = [...new Set([...((criteria.currentCompanyDomains as string[]) ?? []), ...domains])];
  }
  if (ctx.opts.keywords) criteria.keywordsBooleanQuery = ctx.opts.keywords;
  if (!Object.keys(criteria).length) {
    throw new CliError(EXIT.USAGE, 'Add at least one filter, e.g. --title "VP Sales" --company-domain acme.com.', 'See `cleanlist people search --help`.');
  }
  return criteria;
}

const PEOPLE_COLUMNS = ['full_name', 'title', 'company', 'domain', 'location', 'linkedin_url'];

export const peopleCommands: Command[] = [
  {
    name: 'people search',
    summary: 'Find people by title, seniority, location, industry or company. Free. Returns a task_id you can save with `lists add --from-task`.',
    options: {
      ...searchOptions,
      'company-domains-file': { type: 'string', desc: 'File (or -) with one company domain per line; first CSV column is used.' },
      keywords: { type: 'string', desc: 'Boolean keyword query over profiles.' },
      criteria: { type: 'string', desc: 'JSON file (or -) with full PeopleSearchCriteria; flags are applied on top.' },
      limit: { type: 'string', desc: 'Rows per page (default 25).' },
      cursor: { type: 'string', desc: 'Next page of the same search (same filters).' },
      all: { type: 'boolean', desc: 'Keep paging, up to --max-pages. API keys have a daily search cap, so use sparingly.' },
      'max-pages': { type: 'string', desc: 'Page cap for --all (default 5).' },
    },
    view: { rows: (d) => d.results, columns: PEOPLE_COLUMNS },
    examples: [
      'cleanlist people search --title "VP Sales" --seniority "Vice President" --country "United States" --company-size 51-200 --company-size 201-500',
      'cut -d, -f1 accounts.csv | cleanlist people search --company-domains-file - --title "Head of RevOps" --json',
      'cleanlist people search --criteria criteria.json --limit 50',
    ],
    async run(ctx) {
      const criteria = criteriaFrom(ctx);
      const limit = intOpt(ctx.opts.limit, 'limit') ?? 25;
      const maxPages = ctx.opts.all ? (intOpt(ctx.opts['max-pages'], 'max-pages') ?? 5) : 1;
      const streaming = ctx.format === 'csv' || ctx.format === 'jsonl';
      let cursor: string | undefined = ctx.opts.cursor;
      let first: any;
      const results: any[] = [];
      let columns: string[] | undefined;
      for (let page = 0; page < maxPages; page++) {
        const { data } = await ctx.api.post('/api/v2/people/find', { criteria, limit, cursor });
        first ??= data;
        for (const w of data.warnings ?? []) ctx.log(`Warning: ${w}`);
        if (data.truncation_warning) ctx.log(`Warning: ${data.truncation_warning}`);
        if (streaming) columns = printRows(data.results ?? [], ctx.format as 'csv' | 'jsonl', !columns, columns) ?? columns;
        results.push(...(data.results ?? []));
        cursor = data.cursor ?? undefined;
        if (!cursor) break;
      }
      if (first?.task_id) {
        ctx.log(`Search saved as task ${first.task_id}. Save it: cleanlist lists add <list> --from-task ${first.task_id}`);
      }
      if (cursor && !ctx.opts.all) ctx.log(`More results: --cursor ${cursor}`);
      return streaming ? undefined : { ...first, results, cursor: cursor ?? null };
    },
  },
  {
    name: 'people filters',
    args: '<field> [query]',
    summary: 'Look up values: titles, company_industries, job_functions, locations, departments, management_levels, company_headcount.',
    view: { rows: (d) => d.options },
    examples: ['cleanlist people filters company_industries software', 'cleanlist people filters titles "revenue operations"'],
    async run(ctx) {
      if (!ctx.args[0]) throw new CliError(EXIT.USAGE, 'Name the field, e.g. seniority.');
      return (await ctx.api.get('/api/v2/people/find/filters', { field: ctx.args[0], query: ctx.args[1] })).data;
    },
  },
  {
    name: 'people compile',
    summary: 'Show how your filters are interpreted, without running the search.',
    examples: ['cleanlist people compile --title "VP Sales" --country "United States"'],
    options: { ...searchOptions, keywords: { type: 'string', desc: 'Boolean keyword query.' }, criteria: { type: 'string', desc: 'JSON file (or -) with PeopleSearchCriteria.' } },
    async run(ctx) {
      return (await ctx.api.post('/api/v2/people/find/compile', { criteria: criteriaFrom(ctx) })).data;
    },
  },
];
