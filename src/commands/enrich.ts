import { basename } from 'node:path';
import { type Command, confirmSpend, type Ctx, isTerminal, list, poll, readInput, requireArg, resolveList, spend } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { exportCsv, importCsv } from './lists.js';

const enc = encodeURIComponent;
const SCOPES = ['partial', 'full', 'phone-only'];

export function waitForWorkflow(ctx: Ctx, workflowId: string, includeResults = false) {
  return poll(
    ctx,
    async () => (await ctx.api.get(`/api/v2/enrichment/status/${enc(workflowId)}`, { include_results: includeResults || undefined })).data,
    (d: any) => isTerminal(d.status),
    `cleanlist enrich status ${workflowId} --wait`,
    (d: any) => `Enrichment ${d.status}: ${d.processed ?? 0}/${d.total ?? '?'} processed.`,
  );
}

/** The list single lookups land in, when --list isn't given. Creating it is idempotent by name. */
async function scratchList(ctx: Ctx): Promise<string> {
  if (ctx.opts.list) return resolveList(ctx, ctx.opts.list);
  return (await ctx.api.post('/api/v2/lead-lists', { name: 'CLI results' })).data.list_id;
}

function scope(ctx: Ctx): string {
  const s = ctx.opts.scope ?? 'partial';
  if (!SCOPES.includes(s)) throw new CliError(EXIT.USAGE, `--scope must be one of ${SCOPES.join(', ')}.`);
  return s;
}

/** Quote + confirm + start a bulk list enrichment. Returns the start response. */
async function startListEnrichment(ctx: Ctx, listId: string) {
  const s = scope(ctx);
  return spend(ctx, { tool: 'enrich_list', list_id: listId, scope: s }, `Enrich list (${s})`, async (quote_id) =>
    (await ctx.api.post('/api/v2/enrichment/bulk', { list_id: listId, scope: s, quote_id })).data,
  );
}

const scopeOpt = { scope: { type: 'string' as const, desc: 'partial = email + LinkedIn + title + company (1 credit/row, default); full = + phone (11); phone-only (10).' } };
const waitOpts = {
  wait: { type: 'boolean' as const, desc: 'Block until the job finishes.' },
  timeout: { type: 'string' as const, desc: 'Give up waiting after this long (default 30m); exit 8.' },
};

export const enrichCommands: Command[] = [
  {
    name: 'enrich person',
    summary: 'Find contact data for one person. Paid (1 credit, 11 with --phone). Waits for the result unless --no-wait.',
    paid: true,
    options: {
      email: { type: 'string', desc: 'Work email.' },
      linkedin: { type: 'string', desc: 'LinkedIn profile URL.' },
      name: { type: 'string', desc: 'Full name (with --company or --domain).' },
      'first-name': { type: 'string', desc: 'First name.' },
      'last-name': { type: 'string', desc: 'Last name.' },
      company: { type: 'string', desc: 'Company name.' },
      domain: { type: 'string', desc: 'Company domain.' },
      phone: { type: 'boolean', desc: 'Also find a phone number (10 extra credits).' },
      list: { type: 'string', desc: 'Save into this list (default "CLI results").' },
      'no-wait': { type: 'boolean', desc: 'Return the workflow id without waiting.' },
      timeout: waitOpts.timeout,
    },
    examples: ['cleanlist enrich person --linkedin https://linkedin.com/in/jane --yes', 'cleanlist enrich person --name "Jane Doe" --domain acme.com --phone'],
    async run(ctx) {
      const o = ctx.opts;
      const [first, ...rest] = String(o.name ?? '').trim().split(/\s+/);
      const firstName = o['first-name'] ?? (o.name ? first : undefined);
      const lastName = o['last-name'] ?? (o.name && rest.length ? rest.join(' ') : undefined);
      if (!o.email && !o.linkedin && !(firstName && (o.company || o.domain))) {
        throw new CliError(EXIT.USAGE, 'Pass --email, --linkedin, or --name with --company/--domain.');
      }
      await confirmSpend(ctx, { tool: 'enrich_person', include_phone: Boolean(o.phone), row_count: 1 }, 'Enrich person');
      const { data } = await ctx.api.post('/api/v2/enrichment/person', {
        lead_list_id: await scratchList(ctx),
        email: o.email,
        linkedin_url: o.linkedin,
        first_name: firstName,
        last_name: lastName,
        company_name: o.company,
        domain: o.domain,
        include_phone: Boolean(o.phone),
      });
      if (o['no-wait']) return data;
      return waitForWorkflow(ctx, data.workflow_id, true);
    },
  },
  {
    name: 'enrich company',
    summary: 'Firmographics for one company (industry, size, revenue, funding, tech). Paid (1 credit).',
    paid: true,
    options: {
      domain: { type: 'string', desc: 'Company domain.' },
      name: { type: 'string', desc: 'Company name.' },
    },
    examples: ['cleanlist enrich company --domain stripe.com --yes'],
    async run(ctx) {
      if (!ctx.opts.domain && !ctx.opts.name) throw new CliError(EXIT.USAGE, 'Pass --domain or --name.');
      await confirmSpend(ctx, { tool: 'enrich_company', row_count: 1 }, 'Enrich company');
      return (await ctx.api.post('/api/v2/enrichment/company', { domain: ctx.opts.domain, company_name: ctx.opts.name })).data;
    },
  },
  {
    name: 'enrich list',
    args: '<list>',
    summary: 'Enrich every person in a list. Paid: shows a quote first.',
    paid: true,
    options: { ...scopeOpt, ...waitOpts },
    examples: ['cleanlist enrich list "Q4 ABM" --dry-run', 'cleanlist enrich list "Q4 ABM" --scope full --yes --wait'],
    async run(ctx) {
      const data = await startListEnrichment(ctx, await resolveList(ctx, ctx.args[0]));
      return ctx.opts.wait ? waitForWorkflow(ctx, data.workflow_id) : data;
    },
  },
  {
    name: 'enrich task',
    args: '<task_id>',
    summary: 'Enrich the results of a search (its task_id) without saving them first. Paid: shows a quote first.',
    paid: true,
    options: {
      data: { type: 'string', multiple: true, desc: 'Data points: Email, Phone, LinkedIn (company tasks: Industry, Employees, Revenue, Funding, TechStack, Domain).' },
      ids: { type: 'string', multiple: true, desc: 'Only these result ids.' },
      companies: { type: 'boolean', desc: 'The task is a company search.' },
      list: { type: 'string', desc: 'Save results into this list.' },
      ...waitOpts,
    },
    examples: ['cleanlist enrich task tsk_123 --data Email --yes --wait'],
    async run(ctx) {
      const task = ctx.args[0];
      const dataPoints = list(ctx.opts.data);
      if (!task || !dataPoints) throw new CliError(EXIT.USAGE, 'Pass the task id and --data, e.g. --data Email,Phone.');
      const entityIds = list(ctx.opts.ids);
      const tool = ctx.opts.companies ? 'add_company_enrichments' : 'add_person_enrichments';
      const listId = ctx.opts.list ? await resolveList(ctx, ctx.opts.list) : undefined;
      const { data } = await spend(ctx, { tool, task_id: task, data_points: dataPoints, entity_ids: entityIds }, 'Enrich search results', (quote_id) =>
        ctx.api.post('/api/v2/enrichment/by-task', { task_id: task, data_points: dataPoints, entity_ids: entityIds, lead_list_id: listId, quote_id }),
      );
      return ctx.opts.wait && data.workflow_id ? waitForWorkflow(ctx, data.workflow_id) : data;
    },
  },
  {
    name: 'enrich csv',
    args: '<file|->',
    summary: 'Import a CSV into a list, enrich it, and (with -o) write the enriched CSV. Re-running is safe: the list and imported chunks are reused.',
    paid: true,
    options: {
      list: { type: 'string', desc: 'Existing list to import into.' },
      name: { type: 'string', desc: 'Name for a new list (default: "<file> <date>").' },
      map: { type: 'string', multiple: true, desc: 'field=Header column overrides (see `lists import --help`).' },
      out: { type: 'string', short: 'o', desc: 'Write the enriched CSV here (implies --wait).' },
      ...scopeOpt,
      ...waitOpts,
    },
    examples: [
      'cleanlist enrich csv leads.csv --dry-run',
      'cleanlist enrich csv leads.csv --yes -o leads.enriched.csv',
      'cleanlist enrich csv leads.csv --name "Webinar Nov" --scope full --yes --wait --json',
    ],
    async run(ctx) {
      const file = ctx.args[0];
      if (!file) throw new CliError(EXIT.USAGE, 'Pass a CSV file, or - for stdin.');
      const text = readInput(file);
      scope(ctx); // validate before any work
      let listId: string;
      if (ctx.opts.list) listId = await resolveList(ctx, ctx.opts.list);
      else {
        const name = ctx.opts.name ?? `${file === '-' ? 'CLI import' : basename(file)} ${new Date().toISOString().slice(0, 10)}`;
        const { data } = await ctx.api.post('/api/v2/lead-lists', { name });
        listId = data.list_id;
        ctx.log(`${data.reused ? 'Using' : 'Created'} list "${data.name}" (${listId}).`);
      }
      const imported = await importCsv(ctx, listId, text, list(ctx.opts.map, false));
      ctx.log(`Imported ${imported.rows_imported} of ${imported.rows_parsed} rows (${imported.rows_skipped} skipped).`);

      let enrichment: any;
      try {
        enrichment = await startListEnrichment(ctx, listId);
      } catch (e) {
        if (e instanceof CliError) {
          // Free work already happened; say how to pick it up.
          throw new CliError(e.exitCode, e.message, `${e.fix ?? ''} The rows are already imported to list ${listId}; re-running reuses them.`.trim(), { ...e.detail, list_id: listId, import: imported });
        }
        throw e;
      }
      if (ctx.opts.wait || ctx.opts.out) enrichment = await waitForWorkflow(ctx, enrichment.workflow_id);
      const exported = ctx.opts.out ? await exportCsv(ctx, listId, ctx.opts.out) : undefined;
      return { list_id: listId, import: imported, enrichment, export: exported };
    },
  },
  {
    name: 'enrich status',
    args: '<workflow_id>',
    summary: 'Check an enrichment job.',
    examples: ['cleanlist enrich status <workflow_id> --results --wait'],
    options: { results: { type: 'boolean', desc: 'Include per-person results.' }, ...waitOpts },
    async run(ctx) {
      const id = requireArg(ctx, 'workflow id');
      if (ctx.opts.wait) return waitForWorkflow(ctx, id, Boolean(ctx.opts.results));
      return (await ctx.api.get(`/api/v2/enrichment/status/${enc(id)}`, { include_results: ctx.opts.results || undefined })).data;
    },
  },
];
