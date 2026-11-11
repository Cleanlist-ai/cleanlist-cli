import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toError } from '../dist/api.js';
import { confirmSpend, DryRun, list, parseDuration } from '../dist/context.js';
import { chunkRows, csvLine, hasIdentity, mapColumns, parseCsv } from '../dist/csv.js';
import { EXIT } from '../dist/errors.js';

test('parseCsv handles quotes, escaped quotes, newlines in fields, CRLF, BOM and blank lines', () => {
  const text = '﻿Name,Note\r\n"Doe, Jane","said ""hi""\nthen left"\r\n\r\nBob,plain\n';
  assert.deepEqual(parseCsv(text), [
    ['Name', 'Note'],
    ['Doe, Jane', 'said "hi"\nthen left'],
    ['Bob', 'plain'],
  ]);
});

test('csvLine round-trips through parseCsv', () => {
  const row = ['a,b', 'q"uote', 'line\nbreak', '', 'plain'];
  assert.deepEqual(parseCsv(csvLine(row)), [row]);
});

test('chunkRows respects the row cap and repeats the header', () => {
  const rows = Array.from({ length: 1201 }, (_, i) => [`p${i}@x.com`]);
  const chunks = chunkRows(['email'], rows, 1e9, 500);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.startsWith('email\n'));
  assert.equal(chunks.flatMap((c) => parseCsv(c).slice(1)).length, 1201);
});

test('chunkRows respects the byte cap', () => {
  const rows = Array.from({ length: 100 }, () => ['x'.repeat(1000)]);
  const chunks = chunkRows(['col'], rows, 10_000, 500);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 10_000, `chunk is ${Buffer.byteLength(c)} bytes`);
  assert.equal(chunks.flatMap((c) => parseCsv(c).slice(1)).length, 100);
});

test('mapColumns matches common headers and applies overrides', () => {
  const header = ['First Name', 'Last Name', 'Work Email', 'Company', 'Website', 'Notes'];
  assert.deepEqual(mapColumns(header), {
    first_name: 'First Name',
    last_name: 'Last Name',
    email: 'Work Email',
    company_name: 'Company',
    company_domain: 'Website',
  });
  assert.equal(mapColumns(header, ['email=Notes']).email, 'Notes');
  assert.throws(() => mapColumns(header, ['nope=Notes']), (e) => e.exitCode === EXIT.USAGE && /Unknown --map field/.test(e.message) && /first_name/.test(e.fix));
  assert.throws(() => mapColumns(header, ['email=Missing']), (e) => e.exitCode === EXIT.USAGE && /not in the CSV header/.test(e.message) && /Work Email/.test(e.fix));
});

test('hasIdentity needs an email, a LinkedIn URL, or a name plus company', () => {
  assert.ok(hasIdentity({ email: 'E' }));
  assert.ok(hasIdentity({ linkedin_url: 'L' }));
  assert.ok(hasIdentity({ first_name: 'F', last_name: 'L', company_domain: 'D' }));
  assert.ok(!hasIdentity({ first_name: 'F', company_name: 'C' }));
  assert.ok(!hasIdentity({ company_name: 'C' }));
});

test('list() splits commas only when asked', () => {
  assert.deepEqual(list(['vp,director', 'c_suite']), ['vp', 'director', 'c_suite']);
  assert.deepEqual(list(['VP, Sales'], false), ['VP, Sales']);
  assert.equal(list(undefined), undefined);
});

test('parseDuration', () => {
  assert.equal(parseDuration('90s', 0), 90_000);
  assert.equal(parseDuration('10m', 0), 600_000);
  assert.equal(parseDuration(undefined, 5), 5);
  assert.throws(() => parseDuration('soon', 0));
});

// confirmSpend with a fake API that returns a fixed quote.
const quote = (over = {}) => ({ quote_id: 'qte_1', estimated_cost: 120, available_credits: 1000, row_count: 120, sufficient: true, expires_at: 0, tool: 'enrich_list', ...over });
const ctxWith = (opts, q = quote()) => ({ opts, log() {}, api: { post: async () => ({ data: q }) } });

test('paid gate: --yes approves', async () => {
  assert.equal((await confirmSpend(ctxWith({ yes: true }), {}, 'x')).quote_id, 'qte_1');
});

test('paid gate: no TTY and no --yes exits 7 with the quote attached', async () => {
  await assert.rejects(confirmSpend(ctxWith({ 'no-input': true }), {}, 'x'), (e) => e.exitCode === EXIT.CONFIRM && e.detail.quote.quote_id === 'qte_1');
});

test('paid gate: a 0-credit quote still needs --yes (agent and play runs can send email)', async () => {
  await assert.rejects(confirmSpend(ctxWith({ 'no-input': true }, quote({ estimated_cost: 0 })), {}, 'x'), (e) => e.exitCode === EXIT.CONFIRM && e.detail.quote.quote_id === 'qte_1');
  assert.equal((await confirmSpend(ctxWith({ yes: true }, quote({ estimated_cost: 0 })), {}, 'x')).quote_id, 'qte_1');
});

test('paid gate: --max-credits below the quote exits 5, even with --yes', async () => {
  await assert.rejects(confirmSpend(ctxWith({ yes: true, 'max-credits': '100' }), {}, 'x'), (e) => e.exitCode === EXIT.CREDITS);
});

test('paid gate: a --max-credits that is not a number exits 2 instead of switching the cap off', async () => {
  for (const max of ['1,000', '5k', '', 'NaN', '-1']) {
    await assert.rejects(confirmSpend(ctxWith({ yes: true, 'max-credits': max }), {}, 'x'), (e) => e.exitCode === EXIT.USAGE);
  }
  assert.equal((await confirmSpend(ctxWith({ yes: true, 'max-credits': '120.5' }), {}, 'x')).quote_id, 'qte_1');
});

test('paid gate: insufficient balance exits 5', async () => {
  await assert.rejects(confirmSpend(ctxWith({ yes: true }, quote({ sufficient: false })), {}, 'x'), (e) => e.exitCode === EXIT.CREDITS);
});

test('paid gate: --dry-run returns the quote and spends nothing', async () => {
  await assert.rejects(confirmSpend(ctxWith({ 'dry-run': true }), {}, 'x'), (e) => e instanceof DryRun && e.output.quote_id === 'qte_1');
});

test('API errors map to exit codes and keep the server envelope', () => {
  const e = toError(402, { error: { code: 'insufficient_credits', problem: 'Not enough credits', fix: 'Buy more' } });
  assert.equal(e.exitCode, EXIT.CREDITS);
  assert.equal(e.message, 'Not enough credits');
  assert.equal(e.fix, 'Buy more');
  assert.equal(e.apiCode, 'insufficient_credits');
  assert.equal(toError(401, { detail: 'Invalid or expired API key' }).exitCode, EXIT.AUTH);
  assert.equal(toError(404, {}).exitCode, EXIT.NOT_FOUND);
  assert.equal(toError(422, { detail: [{ loc: ['body', 'name'], msg: 'Field required' }] }).message, 'name: Field required');
  assert.equal(toError(429, {}).exitCode, EXIT.RATE_LIMITED);
  assert.equal(toError(500, {}).exitCode, EXIT.ERROR);
});
