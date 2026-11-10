import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataCommands } from '../dist/commands/data.js';
import { EXIT } from '../dist/errors.js';

const cmd = (name) => dataCommands.find((c) => c.name === name);
const quote = { quote_id: 'qte_1', estimated_cost: 40, available_credits: 1000, row_count: 1, sufficient: true, expires_at: 0, tool: 'x' };

/** A ctx whose API records every call and answers from `routes` ("METHOD path" → body or function). */
function fakeCtx(args, opts, routes) {
  const calls = [];
  const answer = async (method, path, body, query) => {
    calls.push({ method, path, body, query });
    const r = routes[`${method} ${path}`];
    if (r === undefined) throw new Error(`unexpected ${method} ${path}`);
    return { status: 200, data: typeof r === 'function' ? r(body ?? query) : r };
  };
  return {
    calls,
    args,
    opts: { 'no-input': true, ...opts },
    log() {},
    api: {
      get: (path, query) => answer('GET', path, undefined, query),
      post: (path, body) => answer('POST', path, body),
      request: (method, path, o = {}) => answer(method, path, o.body, o.query),
    },
  };
}

const tmpFile = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cl-data-')), 'in.csv');
  writeFileSync(p, text);
  return p;
};

test('jobs search quotes job_postings_search for --limit rows and sends the quote_id with the C14 fields', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/jobs/search': { results: [{ title: 'RevOps' }] } };
  const ctx = fakeCtx([], { yes: true, title: ['Head of RevOps'], 'company-domain': ['https://www.Acme.com/careers,beta.io'], 'posted-within-days': '30', limit: '50' }, routes);
  const out = await cmd('jobs search').run(ctx);
  assert.equal(out.results.length, 1);
  assert.deepEqual(ctx.calls[0].body, { tool: 'job_postings_search', row_count: 50 });
  assert.deepEqual(ctx.calls[1].body, {
    titles: ['Head of RevOps'],
    keywords: undefined,
    company_domains: ['acme.com', 'beta.io'],
    company_criteria: undefined,
    locations: undefined,
    posted_within_days: 30,
    limit: 50,
    quote_id: 'qte_1',
  });
});

test('jobs search: without --yes exits 7 after the quote; no filter or a bad --limit is refused before any call', async () => {
  const refused = fakeCtx([], { keyword: ['salesforce'] }, { 'POST /api/v2/credits/estimate': quote });
  await assert.rejects(cmd('jobs search').run(refused), (e) => e.exitCode === EXIT.CONFIRM);
  assert.deepEqual(refused.calls.map((c) => c.path), ['/api/v2/credits/estimate']);
  for (const opts of [{}, { keyword: ['x'], limit: '0' }, { keyword: ['x'], limit: '5000' }, { 'company-criteria': '[1]' }]) {
    const c = fakeCtx([], { yes: true, ...opts }, {});
    await assert.rejects(cmd('jobs search').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('a task handle with no rows is returned as is, never read back through the MCP-only /tasks route', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/linkedin/posts/engagers': { task_id: 'tsk_1', status: 'running' } };
  const logs = [];
  const ctx = fakeCtx(['https://www.linkedin.com/posts/x'], { yes: true }, routes);
  ctx.log = (m) => logs.push(m);
  assert.deepEqual(await cmd('linkedin engagers').run(ctx), { task_id: 'tsk_1', status: 'running' });
  assert.equal(ctx.calls.length, 2);
  assert.ok(logs.some((m) => /lists add <list> --from-task tsk_1/.test(m)));
});

test('companies tech splits --tool on commas and sends the quote_id', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/companies/by-technology': { companies: [] } };
  const ctx = fakeCtx([], { yes: true, tool: ['Outreach,Salesloft'], limit: '5' }, routes);
  await cmd('companies tech').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'companies_by_technology', row_count: 5 });
  assert.deepEqual(ctx.calls[1].body, { tools: ['Outreach', 'Salesloft'], company_criteria: undefined, limit: 5, quote_id: 'qte_1' });
  await assert.rejects(cmd('companies tech').run(fakeCtx([], { yes: true }, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('job-changes check reads URLs from a file (header, quotes, duplicates dropped) and quotes one row each', async () => {
  const file = tmpFile('linkedin_url,name\n"https://linkedin.com/in/a",A\nhttps://linkedin.com/in/b\n\nhttps://linkedin.com/in/a\n');
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/job-changes/check': { results: [] } };
  const ctx = fakeCtx([], { yes: true, file }, routes);
  await cmd('job-changes check').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'job_change_check', row_count: 2 });
  assert.deepEqual(ctx.calls[1].body, { lead_ids: undefined, linkedin_urls: ['https://linkedin.com/in/a', 'https://linkedin.com/in/b'], quote_id: 'qte_1' });
});

test('job-changes check takes exactly one kind of id', async () => {
  for (const opts of [{}, { lead: ['l1'], linkedin: ['https://linkedin.com/in/a'] }]) {
    const c = fakeCtx([], { yes: true, ...opts }, {});
    await assert.rejects(cmd('job-changes check').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('job-changes list and meetings map flags to the C14 query names; meeting ids are encoded', async () => {
  const jc = fakeCtx([], { since: '2026-11-01', list: 'lst_1' }, { 'GET /api/v2/job-changes': { job_changes: [] } });
  await cmd('job-changes list').run(jc);
  assert.deepEqual(jc.calls[0].query, { since: '2026-11-01', list_id: 'lst_1' });
  const ml = fakeCtx([], { account: 'acme.com', person: 'jane@acme.com' }, { 'GET /api/v2/meetings': { meetings: [] } });
  await cmd('meetings list').run(ml);
  assert.deepEqual(ml.calls[0].query, { since: undefined, account_domain: 'acme.com', person_email: 'jane@acme.com' });
  const mr = fakeCtx(['a/b'], {}, { 'GET /api/v2/meetings/a%2Fb': { meeting_id: 'a/b' } });
  assert.equal((await cmd('meetings read').run(mr)).meeting_id, 'a/b');
  await assert.rejects(cmd('meetings read').run(fakeCtx([], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('linkedin posts is free and checks --days; engagers refuse a non-LinkedIn URL and unknown kinds before any call', async () => {
  const ok = fakeCtx(['revops', 'hiring'], { days: '30' }, { 'POST /api/v2/linkedin/posts/search': { posts: [] } });
  await cmd('linkedin posts').run(ok);
  assert.deepEqual(ok.calls[0].body, { keywords: 'revops hiring', days: 30, limit: 10, account_id: undefined });
  await assert.rejects(cmd('linkedin posts').run(fakeCtx(['x'], { days: '3' }, {})), (e) => e.exitCode === EXIT.USAGE);
  for (const [args, opts] of [[['https://evil.com/linkedin.com/x'], {}], [['https://www.linkedin.com/posts/x'], { kinds: ['shares'] }], [[], {}]]) {
    const c = fakeCtx(args, { yes: true, ...opts }, {});
    await assert.rejects(cmd('linkedin engagers').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('linkedin engagers quotes post_engagers and sends both kinds by default', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/linkedin/posts/engagers': { engagers: [] } };
  const ctx = fakeCtx(['https://www.linkedin.com/posts/jane_activity-1'], { yes: true }, routes);
  await cmd('linkedin engagers').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'post_engagers', row_count: 100 });
  assert.deepEqual(ctx.calls[1].body.kinds, ['reactions', 'comments']);
});

test('companies signals needs domains or criteria, and quotes one row per domain', async () => {
  await assert.rejects(cmd('companies signals').run(fakeCtx([], { yes: true }, {})), (e) => e.exitCode === EXIT.USAGE);
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/companies/signals': { signals: [] } };
  const ctx = fakeCtx([], { yes: true, 'domains-file': tmpFile('domain\nacme.com\nbeta.io\n'), type: ['job_postings'], since: '2026-10-01' }, routes);
  await cmd('companies signals').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'company_signals', row_count: 2 });
  assert.deepEqual(ctx.calls[1].body.company_domains, ['acme.com', 'beta.io']);
  assert.deepEqual(ctx.calls[1].body.signal_types, ['job_postings']);
});

test('companies committee and org are free and need a company; the committee table flattens groups', async () => {
  const body = { domain: 'acme.com', groups: [{ label: 'Sales', people: [{ full_name: 'Jane' }] }] };
  const ctx = fakeCtx(['acme.com'], { persona: ['Sales leadership'] }, { 'POST /api/v2/companies/buying-committee': body });
  await cmd('companies committee').run(ctx);
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/companies/buying-committee']);
  assert.deepEqual(ctx.calls[0].body, { company: 'acme.com', personas: ['Sales leadership'] });
  assert.deepEqual(cmd('companies committee').view.rows(body), [{ group: 'Sales', full_name: 'Jane' }]);
  const org = fakeCtx(['acme.com'], {}, { 'GET /api/v2/companies/org-structure': { departments: [] } });
  await cmd('companies org').run(org);
  assert.deepEqual(org.calls[0].query, { company: 'acme.com' });
  for (const name of ['companies committee', 'companies org']) {
    await assert.rejects(cmd(name).run(fakeCtx([], {}, {})), (e) => e.exitCode === EXIT.USAGE);
  }
});

// end to end through the binary: --format csv and stdin
async function runCli(args, input, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(process.execPath, ['dist/cli.js', ...args, '--api-url', url], { env: { ...process.env, CLEANLIST_API_KEY: 'test', CI: '1' } });
    child.stdin.end(input ?? '');
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const code = await new Promise((r) => child.on('close', r));
    return { code, stdout };
  } finally {
    server.close();
  }
}

test('cli: meetings list --format csv prints the rows as CSV', async () => {
  const { code, stdout } = await runCli(['meetings', 'list', '--format', 'csv'], '', (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ meetings: [{ meeting_id: 'm1', title: 'Acme, intro' }] }));
  });
  assert.equal(code, 0);
  assert.equal(stdout, 'meeting_id,title\nm1,"Acme, intro"\n');
});

test('cli: job-changes check --file - reads stdin and exits 7 with the quote when nobody approved', async () => {
  const bodies = [];
  const { code, stdout } = await runCli(['job-changes', 'check', '--file', '-', '--json'], 'https://linkedin.com/in/a\nhttps://linkedin.com/in/b\n', (req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      bodies.push([req.url, JSON.parse(b || '{}')]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...quote, row_count: 2 }));
    });
  });
  assert.equal(code, EXIT.CONFIRM);
  assert.deepEqual(bodies, [['/api/v2/credits/estimate', { tool: 'job_change_check', row_count: 2 }]]);
  assert.equal(JSON.parse(stdout).quote_id, 'qte_1');
});
