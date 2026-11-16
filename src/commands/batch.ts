import { type Command, type Ctx, list, readInput, resolveList, spend } from '../context.js';
import { mapColumns, parseCsv } from '../csv.js';
import { CliError, EXIT } from '../errors.js';
import { waitForWorkflow } from './enrich.js';

export const BATCH_MAX = 1000;
const FIELDS = ['email', 'phone', 'profile'];

/** CSV columns (by the import header aliases) to each route's item keys. */
const PERSON_KEYS: Record<string, string> = { email: 'email', linkedin_url: 'linkedin_url', first_name: 'first_name', last_name: 'last_name', company_domain: 'domain' };
const COMPANY_KEYS: Record<string, string> = { company_domain: 'domain', linkedin_url: 'linkedin_url' };

/**
 * Items from a CSV with a header row, a JSON array (or `{items: [...]}`), or
 * JSON Lines. Empty values are dropped; a row with nothing usable is still
 * sent, so the API reports it on its own row and the row numbers line up.
 */
export function parseItems(text: string, kind: 'people' | 'companies'): Record<string, unknown>[] {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) throw new CliError(EXIT.USAGE, 'The input is empty.');
  let items: unknown[];
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t);
      items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [parsed];
    } catch {
      try {
        items = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
      } catch (e) {
        throw new CliError(EXIT.USAGE, `The input is not valid JSON or JSON Lines: ${(e as Error).message}`);
      }
    }
    return items.map((i) => (i && typeof i === 'object' && !Array.isArray(i) ? Object.fromEntries(Object.entries(i).filter(([, v]) => v !== '' && v !== null && v !== undefined)) : (i as any)));
  }
  const [header, ...rows] = parseCsv(t);
  const mapping = mapColumns(header);
  const keys = kind === 'people' ? PERSON_KEYS : COMPANY_KEYS;
  const cols = Object.entries(keys).filter(([field]) => mapping[field]);
  if (!cols.length && !(kind === 'people' && mapping.full_name)) {
    const want = kind === 'people' ? 'email, linkedin_url, or first_name + last_name + domain' : 'domain or linkedin_url';
    throw new CliError(EXIT.USAGE, `No usable column in the CSV header. It needs ${want}.`);
  }
  const fullName = kind === 'people' && mapping.full_name ? header.indexOf(mapping.full_name) : -1;
  return rows.map((r) => {
    const item: Record<string, string> = {};
    for (const [field, key] of cols) {
      const v = r[header.indexOf(mapping[field])]?.trim();
      if (v) item[key] = v;
    }
    // A single Name column: "Jane van Doe" → first "Jane", last "van Doe".
    const name = fullName >= 0 ? r[fullName]?.trim() : '';
    if (name && !item.first_name && !item.last_name && name.includes(' ')) {
      item.first_name = name.slice(0, name.indexOf(' '));
      item.last_name = name.slice(name.indexOf(' ') + 1).trim();
    }
    return item;
  });
}

function readItems(ctx: Ctx, kind: 'people' | 'companies') {
  const file = ctx.args[0];
  if (!file) throw new CliError(EXIT.USAGE, 'Pass a CSV or JSON file, or - for stdin.');
  const items = parseItems(readInput(file), kind);
  if (items.length > BATCH_MAX) throw new CliError(EXIT.USAGE, `${items.length} rows is over the ${BATCH_MAX}-row batch limit.`, `Split the file into files of ${BATCH_MAX} rows or fewer.`);
  return items;
}

// result_index is the row's index in the enrichment results (`--wait`), which skips refused rows.
const rowsView = { rows: (d: any) => d.rows, columns: ['row', 'status', 'result_index', 'entity_id', 'error'] };

export const batchCommands: Command[] = [
  {
    name: 'batch people',
    args: '<file|->',
    summary: `Look up email, phone or profile for up to ${BATCH_MAX.toLocaleString()} people in one call. Paid: one quote for the batch.`,
    paid: true,
    options: {
      fields: { type: 'string', multiple: true, desc: 'email, phone, profile (comma-separated). Default: email.' },
      list: { type: 'string', desc: 'Save the people into this list (default: your MCP Results list).' },
      wait: { type: 'boolean', desc: 'Wait for the lookup; the result adds `enrichment` with each person found.' },
      timeout: { type: 'string', desc: 'Give up waiting after this long (default 30m); exit 8.' },
    },
    view: rowsView,
    examples: [
      'cleanlist batch people leads.csv --fields email,phone --dry-run',
      'cat leads.csv | cleanlist batch people - --yes --wait --json > found.json',
      'cleanlist batch people people.json --fields profile --yes',
    ],
    async run(ctx) {
      const fields = list(ctx.opts.fields) ?? ['email'];
      const bad = fields.filter((f) => !FIELDS.includes(f));
      if (bad.length) throw new CliError(EXIT.USAGE, `--fields takes ${FIELDS.join(', ')}; got ${bad.join(', ')}.`);
      const items = readItems(ctx, 'people');
      const listId = ctx.opts.list ? await resolveList(ctx, ctx.opts.list) : undefined;
      const { data } = await spend(ctx, { tool: 'batch_people_lookup', row_count: items.length, fields }, `Batch people lookup (${fields.join(', ')})`, (quote_id) =>
        ctx.api.post('/api/v2/batch/people/lookup', { items, fields, quote_id, lead_list_id: listId }),
      );
      ctx.log(`Accepted ${data.accepted_rows} of ${data.total_rows} rows.${data.workflow_id ? ` Check it with \`cleanlist enrich status ${data.workflow_id}\`.` : ''}`);
      if (!ctx.opts.wait || !data.workflow_id) return data;
      return { ...data, enrichment: await waitForWorkflow(ctx, data.workflow_id, true) };
    },
  },
  {
    name: 'batch companies',
    args: '<file|->',
    summary: `Look up up to ${BATCH_MAX.toLocaleString()} companies by domain or LinkedIn URL in one call. Paid: one quote for the batch.`,
    paid: true,
    view: { rows: (d: any) => d.rows, columns: ['row', 'status', 'error', 'company'] },
    examples: ['cleanlist batch companies domains.csv --dry-run', 'cleanlist batch companies - --yes --format jsonl < companies.jsonl'],
    async run(ctx) {
      const items = readItems(ctx, 'companies');
      const { data } = await spend(ctx, { tool: 'batch_companies_lookup', row_count: items.length }, 'Batch company lookup', (quote_id) =>
        ctx.api.post('/api/v2/batch/companies/lookup', { items, quote_id }),
      );
      ctx.log(`Looked up ${data.accepted_rows} of ${data.total_rows} rows.`);
      return data;
    },
  },
];
