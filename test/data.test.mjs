import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataCommands } from '../dist/commands/data.js';
import { toError } from '../dist/api.js';
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

/** A route that prices the request: 400 quote_required with `estimate` until a quote_id comes, then `ok`. */
const priced = (estimate, ok) => (body) => {
  if (!body.quote_id) throw toError(400, { error: { code: 'quote_required', problem: 'needs a quote', details: { estimate, credits: 1 } } });
  return ok;
};

const tmpFile = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cl-data-')), 'in.csv');
  writeFileSync(p, text);
  return p;
};

test("jobs search quotes the route's own estimate and resends the same C14 body with the quote_id", async () => {
  const estimate = { tool: 'job_postings_search', row_count: 50, filters: { titles: ['head of revops'], limit: 50 } };
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/jobs/search': priced(estimate, { results: [{ title: 'RevOps' }] }) };
  const ctx = fakeCtx([], { yes: true, title: ['Head of RevOps'], 'company-domain': ['https://www.Acme.com/careers,beta.io'], 'posted-within-days': '30', limit: '50' }, routes);
  const out = await cmd('jobs search').run(ctx);
  assert.equal(out.results.length, 1);
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/jobs/search', '/api/v2/credits/estimate', '/api/v2/jobs/search']);
  assert.equal(ctx.calls[0].body.quote_id, undefined);
  assert.deepEqual(ctx.calls[1].body, estimate);
  assert.deepEqual(ctx.calls[2].body, {
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

test('jobs search: without --yes exits 7 after the quote; other route errors pass through; no filter or a bad --limit is refused before any call', async () => {
  const refused = fakeCtx([], { keyword: ['salesforce'] }, { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/jobs/search': priced({ tool: 'job_postings_search' }, {}) });
  await assert.rejects(cmd('jobs search').run(refused), (e) => e.exitCode === EXIT.CONFIRM);
  assert.deepEqual(refused.calls.map((c) => c.path), ['/api/v2/jobs/search', '/api/v2/credits/estimate']);
  const invalid = fakeCtx([], { yes: true, keyword: ['x'] }, { 'POST /api/v2/jobs/search': () => { throw toError(422, { error: { code: 'invalid_arguments', problem: 'bad' } }); } });
  await assert.rejects(cmd('jobs search').run(invalid), (e) => e.exitCode === EXIT.USAGE && e.apiCode === 'invalid_arguments');
  assert.equal(invalid.calls.length, 1);
  for (const opts of [{}, { keyword: ['x'], limit: '0' }, { keyword: ['x'], limit: '501' }, { 'company-criteria': '[1]' }]) {
    const c = fakeCtx([], { yes: true, ...opts }, {});
    await assert.rejects(cmd('jobs search').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('a task handle with no rows is returned as is, never read back through the MCP-only /tasks route', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/linkedin/posts/engagers': { task_id: 'tsk_1', status: 'running' } };
  const logs = [];
  const ctx = fakeCtx([], { yes: true, phrase: ['revops'], people: '{"job_titles_include":["VP Sales"]}' }, routes);
  ctx.log = (m) => logs.push(m);
  assert.deepEqual(await cmd('linkedin engagers').run(ctx), { task_id: 'tsk_1', status: 'running' });
  assert.equal(ctx.calls.length, 2);
  assert.ok(logs.some((m) => /lists add <list> --from-task tsk_1/.test(m)));
});

test('companies tech quotes its route body as filters and sends that body with the quote_id; --company-criteria is required', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/companies/by-technology': { companies: [] } };
  const criteria = { industries_include: ['Software Development'] };
  const ctx = fakeCtx([], { yes: true, tool: ['Outreach,Salesloft'], 'company-criteria': JSON.stringify(criteria), limit: '5' }, routes);
  await cmd('companies tech').run(ctx);
  const body = { tools: ['Outreach', 'Salesloft'], company_criteria: criteria, limit: 5 };
  assert.deepEqual(ctx.calls[0].body, { tool: 'companies_by_technology', filters: body });
  assert.deepEqual(ctx.calls[1].body, { ...body, quote_id: 'qte_1' });
  for (const opts of [{}, { tool: ['Outreach'] }, { tool: ['Outreach'], 'company-criteria': '{}' }, { tool: ['Outreach'], 'company-criteria': '{"a":1}', limit: '201' }]) {
    const c = fakeCtx([], { yes: true, ...opts }, {});
    await assert.rejects(cmd('companies tech').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('job-changes check reads URLs from a file (header, quotes, duplicates dropped) and quotes one row each', async () => {
  const file = tmpFile('linkedin_url,name\n"https://linkedin.com/in/a",A\nhttps://linkedin.com/in/b\n\nhttps://linkedin.com/in/a\n');
  const estimate = { tool: 'job_change_check', row_count: 2, filters: { linkedin_urls: ['https://linkedin.com/in/a', 'https://linkedin.com/in/b'] } };
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/job-changes/check': priced(estimate, { results: [] }) };
  const ctx = fakeCtx([], { yes: true, file }, routes);
  await cmd('job-changes check').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { lead_ids: undefined, linkedin_urls: ['https://linkedin.com/in/a', 'https://linkedin.com/in/b'] });
  assert.deepEqual(ctx.calls[1].body, estimate);
  assert.deepEqual(ctx.calls[2].body, { ...ctx.calls[0].body, quote_id: 'qte_1' });
});

test('job-changes check with nothing to charge answers on the first call, with no quote', async () => {
  const ctx = fakeCtx([], { 'no-input': true, lead: ['l1'] }, { 'POST /api/v2/job-changes/check': { results: [{ lead_id: 'l1' }] } });
  assert.equal((await cmd('job-changes check').run(ctx)).results.length, 1);
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/job-changes/check']);
});

test('a quote-bound pull that fails retryably before charging gets a fresh quote; any other failure ends it', async () => {
  let n = 0;
  const quotes = () => ({ ...quote, quote_id: `qte_${++n}` });
  const flaky = (body) => {
    if (body.quote_id === 'qte_1') throw toError(502, { error: { code: 'provider_unavailable', problem: 'down', retryable: true, retry_after_ms: 1 } });
    return { companies: [{ domain: 'a.com' }] };
  };
  const ok = fakeCtx([], { yes: true, tool: ['Outreach'], 'company-criteria': '{"industries":["x"]}' }, { 'POST /api/v2/credits/estimate': quotes, 'POST /api/v2/companies/by-technology': flaky });
  assert.equal((await cmd('companies tech').run(ok)).companies.length, 1);
  assert.deepEqual(ok.calls.map((c) => c.body.quote_id), [undefined, 'qte_1', undefined, 'qte_2']);

  const hard = () => {
    throw toError(500, { error: { code: 'internal', problem: 'boom' } });
  };
  const bad = fakeCtx([], { yes: true, tool: ['Outreach'], 'company-criteria': '{"industries":["x"]}' }, { 'POST /api/v2/credits/estimate': quotes, 'POST /api/v2/companies/by-technology': hard });
  await assert.rejects(cmd('companies tech').run(bad), (e) => e.exitCode === EXIT.ERROR);
  assert.equal(bad.calls.length, 2);
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
  assert.deepEqual(jc.calls[0].query, { since: '2026-11-01', list_id: 'lst_1', limit: 50 });
  const ml = fakeCtx([], { account: 'acme.com', person: 'jane@acme.com' }, { 'GET /api/v2/meetings': { meetings: [] } });
  await cmd('meetings list').run(ml);
  assert.deepEqual(ml.calls[0].query, { since: undefined, account_domain: 'acme.com', person_email: 'jane@acme.com', limit: 25 });
  const mr = fakeCtx(['a/b'], {}, { 'GET /api/v2/meetings/a%2Fb': { meeting_id: 'a/b' } });
  assert.equal((await cmd('meetings read').run(mr)).meeting_id, 'a/b');
  assert.deepEqual(mr.calls[0].query, { transcript: undefined });
  const mt = fakeCtx(['m1'], { transcript: true }, { 'GET /api/v2/meetings/m1': {} });
  await cmd('meetings read').run(mt);
  assert.deepEqual(mt.calls[0].query, { transcript: true });
  for (const [name, limit] of [['job-changes list', '201'], ['meetings list', '101']]) {
    await assert.rejects(cmd(name).run(fakeCtx([], { limit }, {})), (e) => e.exitCode === EXIT.USAGE);
  }
  await assert.rejects(cmd('meetings read').run(fakeCtx([], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('linkedin posts is free and needs --account and a good --days; engagers refuse bad input before any call', async () => {
  const ok = fakeCtx(['revops', 'hiring'], { days: '30', account: 'acc_1' }, { 'POST /api/v2/linkedin/posts/search': { posts: [] } });
  await cmd('linkedin posts').run(ok);
  assert.deepEqual(ok.calls[0].body, { keywords: 'revops hiring', days: 30, limit: 10, account_id: 'acc_1' });
  for (const opts of [{ days: '3', account: 'acc_1' }, {}]) {
    await assert.rejects(cmd('linkedin posts').run(fakeCtx(['x'], opts, {})), (e) => e.exitCode === EXIT.USAGE);
  }
  const people = '{"job_titles_include":["VP Sales"]}';
  for (const opts of [{ author: ['https://evil.com/linkedin.com/x'], people }, { people }, { phrase: ['revops'] }, { phrase: ['revops'], people: '{}' }, { phrase: ['revops'], people, limit: '101' }]) {
    const c = fakeCtx([], { yes: true, ...opts }, {});
    await assert.rejects(cmd('linkedin engagers').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('linkedin engagers quotes its PostEngagersBody as filters and sends that body with the quote_id', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/linkedin/posts/engagers': { people: [] } };
  const ctx = fakeCtx([], { yes: true, author: ['https://www.linkedin.com/in/jane'], phrase: ['cold email'], people: '{"job_titles_include":["VP Sales"]}' }, routes);
  await cmd('linkedin engagers').run(ctx);
  const body = { people: { job_titles_include: ['VP Sales'] }, author_urls: ['https://www.linkedin.com/in/jane'], text_phrases: ['cold email'], posted_within_days: 14, limit: 25 };
  assert.deepEqual(ctx.calls[0].body, { tool: 'post_engagers', filters: body });
  assert.deepEqual(ctx.calls[1].body, { ...body, quote_id: 'qte_1' });
});

test("companies signals needs domains, sends every signal type by default, and quotes the route's estimate", async () => {
  await assert.rejects(cmd('companies signals').run(fakeCtx([], { yes: true }, {})), (e) => e.exitCode === EXIT.USAGE);
  const estimate = { tool: 'company_signals', row_count: 3, filters: { accounts: { domains: ['acme.com'] } } };
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/companies/signals': priced(estimate, { signals: [] }) };
  const ctx = fakeCtx([], { yes: true, 'domains-file': tmpFile('domain\nacme.com\nbeta.io\n'), since: '2026-10-01' }, routes);
  await cmd('companies signals').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { signal_types: ['job_posting', 'news', 'funding', 'headcount'], company_domains: ['acme.com', 'beta.io'], since: '2026-10-01' });
  assert.deepEqual(ctx.calls[1].body, estimate);
  assert.deepEqual(ctx.calls[2].body, { ...ctx.calls[0].body, quote_id: 'qte_1' });
  const typed = fakeCtx([], { yes: true, 'company-domain': ['acme.com'], type: ['funding,news'] }, { 'POST /api/v2/companies/signals': { signals: [] } });
  await cmd('companies signals').run(typed);
  assert.deepEqual(typed.calls[0].body.signal_types, ['funding', 'news']);
  assert.equal(typed.calls.length, 1);
});

test('companies committee and org are free and need a company; the committee table flattens groups', async () => {
  const body = { domain: 'acme.com', groups: [{ label: 'Sales', people: [{ full_name: 'Jane' }] }] };
  const ctx = fakeCtx(['acme.com'], { persona: ['Sales leadership=VP Sales, CRO', '{"label":"RevOps","titles":["Head of RevOps"],"count":2}'] }, { 'POST /api/v2/companies/buying-committee': body });
  await cmd('companies committee').run(ctx);
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/companies/buying-committee']);
  assert.deepEqual(ctx.calls[0].body, {
    company: 'acme.com',
    personas: [{ label: 'Sales leadership', titles: ['VP Sales', 'CRO'] }, { label: 'RevOps', titles: ['Head of RevOps'], count: 2 }],
  });
  for (const persona of [['RevOps'], ['=VP Sales'], ['RevOps='], ['a=x', 'b=y', 'c=z', 'd=w']]) {
    const c = fakeCtx(['acme.com'], { persona }, {});
    await assert.rejects(cmd('companies committee').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
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
      if (req.url === '/api/v2/credits/estimate') return res.end(JSON.stringify({ ...quote, row_count: 2 }));
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: 'quote_required', problem: 'needs a quote', details: { estimate: { tool: 'job_change_check', row_count: 2, filters: { n: 2 } } } } }));
    });
  });
  assert.equal(code, EXIT.CONFIRM);
  const urls = ['https://linkedin.com/in/a', 'https://linkedin.com/in/b'];
  assert.deepEqual(bodies, [['/api/v2/job-changes/check', { linkedin_urls: urls }], ['/api/v2/credits/estimate', { tool: 'job_change_check', row_count: 2, filters: { n: 2 } }]]);
  assert.equal(JSON.parse(stdout).quote_id, 'qte_1');
});
