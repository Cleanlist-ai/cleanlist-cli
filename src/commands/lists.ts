import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chunkRows, hasIdentity, mapColumns, parseCsv } from '../csv.js';
import { type Command, confirmAction, type Ctx, intOpt, list, poll, readInput, resolveList } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { printRows } from '../output.js';

const LEAD_COLUMNS = ['full_name', 'title', 'company', 'email', 'phone', 'linkedin_url'];
const enc = encodeURIComponent;

/**
 * Page through `GET /lead-lists/{id}/leads`. For csv/jsonl each page is
 * written as it arrives; otherwise the pages are collected and returned.
 */
async function rows(ctx: Ctx, listId: string) {
  const limit = intOpt(ctx.opts.limit, 'limit');
  const all = Boolean(ctx.opts.all);
  const streaming = ctx.format === 'csv' || ctx.format === 'jsonl';
  let cursor: string | undefined = ctx.opts.cursor;
  let first: any;
  const leads: any[] = [];
  let columns: string[] | undefined;
  do {
    const want = limit ? Math.min(500, limit - leads.length) : all ? 500 : 100;
    const { data } = await ctx.api.get(`/api/v2/lead-lists/${enc(listId)}/leads`, { limit: want, cursor });
    first ??= data;
    if (streaming) columns = printRows(data.leads ?? [], ctx.format as 'csv' | 'jsonl', !columns, columns) ?? columns;
    leads.push(...(data.leads ?? []));
    cursor = data.cursor ?? undefined;
    if (all && cursor) ctx.log(`Fetched ${leads.length} of ${data.total}…`);
  } while (cursor && (all || (limit !== undefined && leads.length < limit)));
  if (streaming) return undefined;
  return { ...first, leads, cursor: cursor ?? null };
}

/** Import a CSV into a list in ≤500-row chunks. Idempotent per chunk for 24h, so re-runs don't duplicate. */
export async function importCsv(ctx: Ctx, listId: string, text: string, maps: string[] = []) {
  const [header, ...data] = parseCsv(text);
  if (!header || !data.length) throw new CliError(EXIT.USAGE, 'The CSV has no data rows.');
  let mapping: Record<string, string>;
  try {
    mapping = mapColumns(header, maps);
  } catch (e) {
    throw new CliError(EXIT.USAGE, (e as Error).message);
  }
  if (!hasIdentity(mapping)) {
    throw new CliError(
      EXIT.USAGE,
      `Couldn't find an email, LinkedIn URL, or name + company column in: ${header.join(', ')}`,
      'Map columns with --map, e.g. --map email="Work Email" --map company_domain=Website',
    );
  }
  ctx.log(`Columns: ${Object.entries(mapping).map(([f, h]) => `${h} → ${f}`).join(', ')}`);

  const chunks = chunkRows(header, data);
  const totals = { list_id: listId, rows_parsed: 0, rows_imported: 0, rows_skipped: 0, chunks: chunks.length, replayed_chunks: 0, skip_reasons: {} as Record<string, number> };
  for (const [i, chunk] of chunks.entries()) {
    const { data: r } = await ctx.api.post(`/api/v2/lead-lists/${enc(listId)}/csv-import`, {
      csv_content_base64: Buffer.from(chunk).toString('base64'),
      column_mapping: mapping,
      // The import is free and never enriches: `enrich csv` quotes and runs
      // enrichment itself. The API dispatches enrichment unless told not to,
      // and refuses a dispatch without enrichment_type (422).
      dispatch_enrichment: false,
      idempotency_key: 'cli-' + createHash('sha256').update(listId + '\0' + chunk).digest('hex').slice(0, 40),
    });
    totals.rows_parsed += r.rows_parsed ?? 0;
    totals.rows_imported += r.rows_imported ?? 0;
    totals.rows_skipped += r.rows_skipped ?? 0;
    if (r.idempotency_replayed) totals.replayed_chunks++;
    for (const [k, v] of Object.entries(r.skip_reasons ?? {})) totals.skip_reasons[k] = (totals.skip_reasons[k] ?? 0) + Number(v);
    if (chunks.length > 1) ctx.log(`Imported chunk ${i + 1}/${chunks.length} (${totals.rows_imported} rows so far).`);
  }
  return totals;
}

/** Export a list to CSV: start the job, re-ask with job_id until done, then download. */
export async function exportCsv(ctx: Ctx, listId: string, outPath?: string) {
  const body: Record<string, unknown> = { list_id: listId, columns: list(ctx.opts.columns), include_smart_agents: ctx.opts['smart-agents'] ? true : undefined };
  const job = await poll(
    ctx,
    async () => {
      const { data } = await ctx.api.post('/api/v2/export/csv/signed-url', body);
      if (data.job_id) body.job_id = data.job_id;
      return data;
    },
    (d: any) => d.status === 'completed' && d.download_url,
    `cleanlist lists export ${listId}${outPath ? ` -o ${outPath}` : ''}`,
    () => 'Export still running…',
  );
  const res = await fetch(job.download_url);
  if (!res.ok || !res.body) throw new CliError(EXIT.ERROR, `Download failed (${res.status}).`);
  const src = Readable.fromWeb(res.body as any);
  if (outPath) {
    await pipeline(src, createWriteStream(outPath));
    ctx.log(`Wrote ${job.row_count} rows to ${outPath}.`);
    return { list_id: listId, path: outPath, row_count: job.row_count, skipped_count: job.skipped_count };
  }
  await pipeline(src, process.stdout, { end: false });
  return undefined;
}

export const listCommands: Command[] = [
  {
    name: 'lists',
    summary: 'List lead lists.',
    options: {
      limit: { type: 'string', desc: 'Page size (default 50).' },
      cursor: { type: 'string', desc: 'Next-page cursor from a previous call.' },
      folder: { type: 'string', desc: 'Only lists in this folder id.' },
    },
    view: { rows: (d) => d.lists, columns: ['name', 'lead_count', 'list_id', 'owner_name', 'visibility', 'created_at'] },
    examples: ['cleanlist lists', 'cleanlist lists --json | jq -r \'.lists[].name\''],
    async run(ctx) {
      return (await ctx.api.get('/api/v2/lead-lists', { limit: ctx.opts.limit ?? 50, cursor: ctx.opts.cursor, folder_id: ctx.opts.folder })).data;
    },
  },
  {
    name: 'lists get',
    args: '<list>',
    summary: 'Show one list (by id or exact name).',
    examples: ['cleanlist lists get "Q4 ABM"'],
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/lead-lists/${enc(await resolveList(ctx, ctx.args[0]))}`)).data;
    },
  },
  {
    name: 'lists create',
    args: '<name>',
    summary: 'Create a list. Returns the existing list if one with this name already exists (reused: true).',
    options: { description: { type: 'string', desc: 'List description.' } },
    examples: ['cleanlist lists create "Q4 ABM"'],
    async run(ctx) {
      if (!ctx.args[0]) throw new CliError(EXIT.USAGE, 'Pass the new list name.');
      return (await ctx.api.post('/api/v2/lead-lists', { name: ctx.args[0], description: ctx.opts.description })).data;
    },
  },
  {
    name: 'lists rename',
    args: '<list> <new-name>',
    summary: 'Rename a list.',
    examples: ['cleanlist lists rename "Q4 ABM" "Q4 ABM (old)"'],
    async run(ctx) {
      if (!ctx.args[1]) throw new CliError(EXIT.USAGE, 'Pass the list and its new name.');
      const id = await resolveList(ctx, ctx.args[0]);
      return (await ctx.api.request('PATCH', `/api/v2/lead-lists/${enc(id)}`, { body: { name: ctx.args[1] } })).data;
    },
  },
  {
    name: 'lists delete',
    args: '<list>',
    summary: 'Delete a list. Asks first; needs --yes without a terminal.',
    examples: ['cleanlist lists delete "Q4 ABM (old)" --yes'],
    paid: true,
    async run(ctx) {
      const id = await resolveList(ctx, ctx.args[0]);
      await confirmAction(ctx, `Delete list ${ctx.args[0]}?`);
      return (await ctx.api.request('DELETE', `/api/v2/lead-lists/${enc(id)}`)).data;
    },
  },
  {
    name: 'lists rows',
    args: '<list>',
    summary: 'Read the people in a list. --format csv|jsonl streams every page with --all.',
    options: {
      limit: { type: 'string', desc: 'Max rows (default 100).' },
      all: { type: 'boolean', desc: 'Fetch every page.' },
      cursor: { type: 'string', desc: 'Start from this cursor.' },
    },
    view: { rows: (d) => d.leads, columns: LEAD_COLUMNS },
    examples: ['cleanlist lists rows "Q4 ABM" --all --format csv > q4.csv', 'cleanlist lists rows "Q4 ABM" --limit 20'],
    async run(ctx) {
      return rows(ctx, await resolveList(ctx, ctx.args[0]));
    },
  },
  {
    name: 'lists add',
    args: '<list>',
    summary: 'Save people to a list: a search result (--from-task) or known lead ids.',
    options: {
      'from-task': { type: 'string', desc: 'task_id returned by `people search`.' },
      ids: { type: 'string', multiple: true, desc: 'With --from-task: only these result ids (lead_id column).' },
      'lead-ids': { type: 'string', multiple: true, desc: 'Lead ids to add.' },
    },
    examples: ['cleanlist lists add "Q4 ABM" --from-task tsk_123', 'cleanlist lists add "Q4 ABM" --lead-ids id1,id2'],
    async run(ctx) {
      const id = await resolveList(ctx, ctx.args[0]);
      const task = ctx.opts['from-task'];
      const leadIds = list(ctx.opts['lead-ids']);
      if (!task && !leadIds) throw new CliError(EXIT.USAGE, 'Pass --from-task <task_id> or --lead-ids.');
      const body = task ? { task_id: task, entity_ids: list(ctx.opts.ids) } : { lead_ids: leadIds };
      return (await ctx.api.post(`/api/v2/lead-lists/${enc(id)}/leads`, body)).data;
    },
  },
  {
    name: 'lists remove',
    args: '<list>',
    summary: 'Remove people from a list by lead id.',
    examples: ['cleanlist lists remove "Q4 ABM" --lead-ids <lead_id>,<lead_id>'],
    options: { 'lead-ids': { type: 'string', multiple: true, desc: 'Lead ids to remove.' } },
    async run(ctx) {
      const id = await resolveList(ctx, ctx.args[0]);
      const leadIds = list(ctx.opts['lead-ids']);
      if (!leadIds) throw new CliError(EXIT.USAGE, 'Pass --lead-ids.');
      return (await ctx.api.request('DELETE', `/api/v2/lead-lists/${enc(id)}/leads`, { body: { lead_ids: leadIds } })).data;
    },
  },
  {
    name: 'lists import',
    args: '<list> <file|->',
    summary: 'Import a CSV into a list (free; no enrichment). Columns are matched by header; override with --map.',
    options: { map: { type: 'string', multiple: true, desc: 'field=Header, e.g. email="Work Email". Fields: email, first_name, last_name, full_name, linkedin_url, company_name, company_domain, job_title, phone, mobile_phone, work_phone, city, state, country.' } },
    examples: ['cleanlist lists import "Q4 ABM" leads.csv', 'cat leads.csv | cleanlist lists import "Q4 ABM" -'],
    async run(ctx) {
      if (!ctx.args[1]) throw new CliError(EXIT.USAGE, 'Pass the list and a CSV file (or - for stdin).');
      const id = await resolveList(ctx, ctx.args[0]);
      return importCsv(ctx, id, readInput(ctx.args[1]), list(ctx.opts.map, false));
    },
  },
  {
    name: 'lists export',
    args: '<list>',
    summary: 'Export a list as CSV: to stdout, or a file with -o.',
    options: {
      out: { type: 'string', short: 'o', desc: 'Write to this file instead of stdout.' },
      columns: { type: 'string', multiple: true, desc: 'Columns to include, in order.' },
      'smart-agents': { type: 'boolean', desc: 'Include smart-agent (AI) columns.' },
    },
    examples: ['cleanlist lists export "Q4 ABM" -o q4.csv', 'cleanlist lists export "Q4 ABM" | head'],
    async run(ctx) {
      // Without -o the CSV itself goes to stdout and this returns nothing.
      return exportCsv(ctx, await resolveList(ctx, ctx.args[0]), ctx.opts.out);
    },
  },
];
