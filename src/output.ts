import { csvLine } from './csv.js';

export type Format = 'table' | 'json' | 'jsonl' | 'csv';

/** How a command's response becomes rows, for table/csv/jsonl output. */
export interface View {
  /** Pull the row array out of the API body. Omit for single-object responses. */
  rows?: (data: any) => any[];
  /** Columns for the table (csv/jsonl keep every field). */
  columns?: string[];
}

const out = (s: string) => process.stdout.write(s);

/** Shown once when the server says a call ran in test mode. */
export const TEST_BANNER = 'TEST mode: sandbox workspace. Nothing is sent to real people or charged.';

/** Messages for humans: stderr, so stdout stays clean data. Silenced by --quiet. */
export function info(msg: string, quiet = false): void {
  if (!quiet) process.stderr.write(msg + '\n');
}

export function print(data: unknown, format: Format, view: View = {}): void {
  if (data === undefined) return;
  if (format === 'json') return void out(JSON.stringify(data, null, 2) + '\n');

  const rows = view.rows ? view.rows(data) ?? [] : [data];
  if (format === 'jsonl') return void printRows(rows, 'jsonl', true);
  if (format === 'csv') return void printRows(rows, 'csv', true);

  // table
  if (!view.rows) return void out(keyValue(data as Record<string, unknown>));
  if (!rows.length) return void out('(no rows)\n');
  out(table(rows, view.columns ?? Object.keys(rows[0])));
  const meta = data as { total?: number; cursor?: string | null };
  if (typeof meta.total === 'number' && meta.total > rows.length) {
    info(`Showing ${rows.length} of ${meta.total}.${meta.cursor ? ` Next page: --cursor ${meta.cursor}` : ''}`);
  }
}

/** Write rows as CSV or JSONL. `header` is false for later pages of a stream. */
export function printRows(rows: any[], format: 'csv' | 'jsonl', header: boolean, columns?: string[]): string[] | undefined {
  if (format === 'jsonl') {
    for (const r of rows) out(JSON.stringify(r) + '\n');
    return;
  }
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  if (header && cols.length) out(csvLine(cols));
  for (const r of rows) out(csvLine(cols.map((c) => r?.[c])));
  return cols;
}

// The API's agent-facing fields; noise in a human table.
const HIDDEN = new Set(['agent_instructions', 'usage', 'timestamp_ms', 'task_id', 'message']);

function keyValue(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj ?? {}).filter(([k, v]) => !HIDDEN.has(k) && v !== null && v !== undefined);
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${k.padEnd(width)}  ${cell(v, 100)}`).join('\n') + '\n';
}

function cell(v: unknown, max: number): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function table(rows: any[], cols: string[]): string {
  const cells = rows.map((r) => cols.map((c) => cell(r?.[c], 40)));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd() + '\n';
  return line(cols.map((c) => c.toUpperCase())) + cells.map(line).join('');
}
