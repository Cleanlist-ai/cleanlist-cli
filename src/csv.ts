import { CliError, EXIT } from './errors.js';

/** RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank lines (a lone empty field).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\n';
}

/**
 * Split data rows into chunks the import endpoint accepts: it caps a body at
 * 150 KB / ~600 rows, so stay under both with headroom. Each chunk repeats the
 * header line.
 */
export function chunkRows(header: string[], rows: string[][], maxBytes = 140_000, maxRows = 500): string[] {
  const head = csvLine(header);
  const chunks: string[] = [];
  let body = '';
  let count = 0;
  for (const r of rows) {
    const line = csvLine(r);
    if (count > 0 && (count >= maxRows || Buffer.byteLength(head + body + line) > maxBytes)) {
      chunks.push(head + body);
      body = '';
      count = 0;
    }
    body += line;
    count++;
  }
  if (count) chunks.push(head + body);
  return chunks;
}

/** Canonical import fields and the header spellings we map to them automatically. */
const ALIASES: Record<string, string[]> = {
  email: ['email', 'emailaddress', 'workemail', 'businessemail'],
  first_name: ['firstname', 'first', 'givenname'],
  last_name: ['lastname', 'last', 'surname', 'familyname'],
  full_name: ['name', 'fullname', 'contactname', 'personname'],
  linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'profileurl', 'personlinkedinurl'],
  company_name: ['company', 'companyname', 'organization', 'organisation', 'account', 'accountname', 'employer'],
  company_domain: ['domain', 'companydomain', 'website', 'companywebsite', 'url', 'companyurl'],
  job_title: ['title', 'jobtitle', 'position', 'role'],
  phone: ['phone', 'phonenumber', 'telephone'],
  mobile_phone: ['mobile', 'mobilephone', 'cell', 'cellphone'],
  work_phone: ['workphone', 'officephone', 'directdial'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region', 'stateprovince'],
  country: ['country', 'countrycode'],
};
export const CANONICAL_FIELDS = Object.keys(ALIASES);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `{canonical_field: header}` from the header row, then `--map field=Header` overrides. */
export function mapColumns(header: string[], overrides: string[] = []): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const h of header) {
    const n = norm(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (!mapping[field] && names.includes(n)) {
        mapping[field] = h;
        break;
      }
    }
  }
  for (const o of overrides) {
    const eq = o.indexOf('=');
    if (eq < 1) throw new CliError(EXIT.USAGE, `--map expects field=Header, got "${o}".`);
    const field = o.slice(0, eq).trim();
    const col = o.slice(eq + 1).trim();
    if (!CANONICAL_FIELDS.includes(field)) {
      throw new CliError(EXIT.USAGE, `Unknown --map field "${field}".`, `Fields: ${CANONICAL_FIELDS.join(', ')}.`);
    }
    if (!header.includes(col)) throw new CliError(EXIT.USAGE, `Column "${col}" is not in the CSV header.`, `Columns: ${header.join(', ')}.`);
    mapping[field] = col;
  }
  return mapping;
}

/** True when the mapping can identify a person: an email, a LinkedIn URL, or a name plus a company. */
export function hasIdentity(m: Record<string, string>): boolean {
  const name = m.full_name || (m.first_name && m.last_name);
  return Boolean(m.email || m.linkedin_url || (name && (m.company_name || m.company_domain)));
}
