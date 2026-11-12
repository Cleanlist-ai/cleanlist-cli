import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api, toError } from '../dist/api.js';
import { actionCommands } from '../dist/commands/actions.js';
import { agentCommands } from '../dist/commands/agents.js';
import { mergeCodexConfig } from '../dist/commands/mcp.js';
import { skillCommands, SKILL_BODY } from '../dist/commands/skill.js';
import { EXIT } from '../dist/errors.js';

const cmd = (list, name) => list.find((c) => c.name === name);

/** A local API answering from `handler`; returns its base URL and a request log. */
async function server(handler) {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res, hits.length);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => srv.close() };
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
// retry_after_ms keeps the test fast.
const gatewayError = (res, status) => send(res, status, { error: { code: 'upstream', problem: 'Bad gateway', retry_after_ms: 1 } });

/** A ctx whose API records every call and answers from `routes` ("METHOD path" → body). */
function fakeCtx(args, opts, routes) {
  const calls = [];
  const answer = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (r === undefined) throw new Error(`unexpected ${method} ${path}`);
    if (r instanceof Error) throw r;
    return { status: 200, data: r };
  };
  return {
    calls,
    args,
    opts: { 'no-input': true, ...opts },
    log() {},
    api: { get: (p) => answer('GET', p), post: (p, b) => answer('POST', p, b), request: (m, p, o = {}) => answer(m, p, o.body) },
  };
}

/** Run the built CLI with no TTY and the given env. */
async function runCli(args, env = {}) {
  const child = spawn(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, CI: '1', CLEANLIST_API_KEY: 'clapi_test', ...env } });
  child.stdin.end('');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => child.on('close', r));
  return { code, stdout, stderr };
}

// Retries: GET only, on 502/503/504 only.

test('a GET is retried on 502, 503 and 504, then succeeds', async () => {
  for (const status of [502, 503, 504]) {
    const s = await server((req, res, n) => (n === 1 ? gatewayError(res, status) : send(res, 200, { ok: true })));
    try {
      const { data } = await new Api(s.url, { type: 'api_key', key: 'k' }, 'default', false).get('/api/v2/x');
      assert.deepEqual(data, { ok: true });
      assert.deepEqual(s.hits, ['GET /api/v2/x', 'GET /api/v2/x'], `status ${status}`);
    } finally {
      s.close();
    }
  }
});

test('a GET stops after 3 tries, and is not retried on 429 or 500', async () => {
  const s = await server((req, res) => gatewayError(res, 503));
  try {
    await assert.rejects(new Api(s.url, { type: 'api_key', key: 'k' }, 'default', false).get('/api/v2/x'), (e) => e.exitCode === EXIT.ERROR);
    assert.equal(s.hits.length, 3);
  } finally {
    s.close();
  }
  for (const status of [429, 500]) {
    const t = await server((req, res) => gatewayError(res, status));
    try {
      await assert.rejects(new Api(t.url, { type: 'api_key', key: 'k' }, 'default', false).get('/api/v2/x'));
      assert.equal(t.hits.length, 1, `status ${status}`);
    } finally {
      t.close();
    }
  }
});

test('POST, PATCH, PUT and DELETE are never retried, even on 502/503/504', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    for (const status of [502, 503, 504]) {
      const s = await server((req, res) => gatewayError(res, status));
      try {
        await assert.rejects(new Api(s.url, { type: 'api_key', key: 'k' }, 'default', false).request(method, '/api/v2/x', { body: {} }));
        assert.deepEqual(s.hits, [`${method} /api/v2/x`], `${method} ${status}`);
      } finally {
        s.close();
      }
    }
  }
});

test('a POST that gets no response is not resent, and says the write may have gone through', async () => {
  const s = await server(() => {});
  const url = s.url;
  s.close(); // nothing listens: connection refused
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(new Api(url, { type: 'api_key', key: 'k' }, 'default', false).post('/api/v2/x', {}), (e) => /not resent/.test(e.fix));
});

// mcp install: update in place.

test('mcp install claude-code updates an existing entry in place, never removing it, and leaves the rest alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-mcp-'));
  const path = join(dir, '.claude.json');
  const original = {
    numStartups: 7,
    mcpServers: { first: { type: 'stdio', command: 'a' }, cleanlist: { type: 'http', url: 'https://old.example/mcp' }, last: { type: 'http', url: 'https://x' } },
    projects: { '/p': { allowedTools: [] } },
  };
  writeFileSync(path, JSON.stringify(original, null, 2));
  // PATH has no `claude`: the update must not shell out to `claude mcp remove/add`.
  const env = { CLAUDE_CONFIG_DIR: dir, HOME: dir, PATH: '/nonexistent' };

  const first = await runCli(['mcp', 'install', 'claude-code', '--yes', '--json'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).changed, true);
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(cfg.mcpServers.cleanlist, { type: 'http', url: 'https://mcp.cleanlist.ai/v1/mcp' });
  assert.deepEqual(Object.keys(cfg.mcpServers), ['first', 'cleanlist', 'last']); // same position
  assert.deepEqual({ ...cfg, mcpServers: undefined }, { ...original, mcpServers: undefined });
  assert.deepEqual(cfg.mcpServers.first, original.mcpServers.first);

  const again = await runCli(['mcp', 'install', 'claude-code', '--yes', '--json'], env);
  assert.equal(JSON.parse(again.stdout).changed, false);

  // Switching to a key rewrites the same entry, privately, and never prints the key.
  const key = 'clapi_abcdefghijklmnopqrstuvwxyz';
  const keyed = await runCli(['mcp', 'install', 'claude-code', '--api-key', key, '--yes', '--json'], env);
  assert.equal(keyed.code, 0, keyed.stderr);
  assert.ok(!keyed.stderr.includes(key));
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.mcpServers.cleanlist.type, 'stdio');
  assert.equal(after.mcpServers.cleanlist.env.CLEANLIST_API_KEY, key);
  assert.deepEqual(Object.keys(after.mcpServers), ['first', 'cleanlist', 'last']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('mcp install claude-code without --yes and no TTY exits 7 and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-mcp-'));
  const path = join(dir, '.claude.json');
  writeFileSync(path, '{"mcpServers":{}}');
  const r = await runCli(['mcp', 'install', 'claude-code'], { CLAUDE_CONFIG_DIR: dir, HOME: dir });
  assert.equal(r.code, EXIT.CONFIRM);
  assert.equal(readFileSync(path, 'utf8'), '{"mcpServers":{}}');
});

test('mergeCodexConfig replaces the cleanlist table where it stands', () => {
  const before = '[a]\nx = 1\n\n[mcp_servers.cleanlist]\nurl = "old"\n\n[mcp_servers.cleanlist.env]\nK = "v"\n\n[z]\ny = 2\n';
  assert.equal(mergeCodexConfig(before, '[mcp_servers.cleanlist]\nurl = "new"\n'), '[a]\nx = 1\n\n[mcp_servers.cleanlist]\nurl = "new"\n\n[z]\ny = 2\n');
  assert.equal(mergeCodexConfig('[a]\nx = 1\n', '[mcp_servers.cleanlist]\nurl = "new"\n'), '[a]\nx = 1\n\n[mcp_servers.cleanlist]\nurl = "new"\n');
});

test('mergeCodexConfig finds the cleanlist table however its header is quoted or spaced', () => {
  for (const header of ['[mcp_servers."cleanlist"]', "[ mcp_servers . 'cleanlist' ]", '[mcp_servers."cleanlist".env]']) {
    const out = mergeCodexConfig(`${header}\nurl = "old"\n`, '[mcp_servers.cleanlist]\nurl = "new"\n');
    assert.equal(out, '[mcp_servers.cleanlist]\nurl = "new"\n', header);
  }
  // A header the decoder can't read (or a \\U escape) is someone else's table, kept as it is.
  for (const kept of ['[profiles."\\U00000077ork"]\nx = 1\n', '[profiles."\\q"]\nx = 1\n']) {
    assert.ok(mergeCodexConfig(kept, '[mcp_servers.cleanlist]\nurl = "new"\n').startsWith(kept), kept);
  }
  assert.equal(mergeCodexConfig('[mcp_servers."\\u0063leanlist"]\nurl = "old"\n', '[mcp_servers.cleanlist]\nurl = "new"\n'), '[mcp_servers.cleanlist]\nurl = "new"\n');
  // A single quoted key with a dot in it is another table.
  const other = '["mcp_servers.cleanlist"]\nx = 1\n';
  assert.ok(mergeCodexConfig(other, '[mcp_servers.cleanlist]\nurl = "new"\n').startsWith(other));
});

// Refusals the CLI can't work around.

test('person_required and opt_in_scope_required say who can do it and where', () => {
  const person = toError(403, { error: { code: 'person_required', problem: 'agents.set_status turns an agent on.', fix: 'server fix' } });
  assert.equal(person.exitCode, EXIT.AUTH);
  assert.equal(person.apiCode, 'person_required');
  assert.match(person.fix, /Cleanlist app/);
  const scope = toError(403, { error: { code: 'opt_in_scope_required', problem: 'x', details: { required_scope: 'crm:write' } } });
  assert.match(scope.fix, /"crm:write"/);
  assert.match(scope.fix, /Settings → API keys/);
});

// actions

const card = {
  action: 'lists.delete',
  session_id: 'ses_1',
  kind: 'card',
  card: { card_id: 'crd_1', title: 'Delete list', summary: 'Deletes Q4 ABM.', credits_required: 0, expires_at: '2026-11-12T00:00:00Z' },
};
const routes = { 'POST /api/v2/actions/lists.delete': card, 'POST /api/v2/actions/confirm': { card_id: 'crd_1', status: 'done', result: { ok: true } } };

test('actions run: a card without --yes and no TTY exits 7 with the card and confirms nothing', async () => {
  const ctx = fakeCtx(['lists.delete'], { args: '{"list_id":"l1"}' }, routes);
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => e.exitCode === EXIT.CONFIRM && e.detail.card.card.card_id === 'crd_1' && /actions confirm crd_1 --session ses_1/.test(e.fix));
  assert.deepEqual(ctx.calls, [{ method: 'POST', path: '/api/v2/actions/lists.delete', body: { arguments: { list_id: 'l1' }, session_id: undefined } }]);
});

test('actions run: --yes confirms the card once, in its session', async () => {
  const ctx = fakeCtx(['lists.delete'], { yes: true }, routes);
  assert.equal((await cmd(actionCommands, 'actions run').run(ctx)).status, 'done');
  assert.deepEqual(ctx.calls[1], { method: 'POST', path: '/api/v2/actions/confirm', body: { card_id: 'crd_1', session_id: 'ses_1' } });
});

test('actions confirm refuses --dry-run and sends nothing', async () => {
  const ctx = fakeCtx(['crd_1'], { session: 'sess_1', 'dry-run': true }, routes);
  await assert.rejects(cmd(actionCommands, 'actions confirm').run(ctx), (e) => e.exitCode === EXIT.USAGE);
  assert.deepEqual(ctx.calls, []);
});

test('actions confirm refuses --max-credits and sends nothing: the cap is checked at actions run', async () => {
  const ctx = fakeCtx(['crd_1'], { session: 'sess_1', 'max-credits': '10' }, routes);
  await assert.rejects(cmd(actionCommands, 'actions confirm').run(ctx), (e) => e.exitCode === EXIT.USAGE && /actions run/.test(e.message));
  assert.deepEqual(ctx.calls, []);
});

test('skill --target agents replaces an older Cleanlist section in AGENTS.md and keeps the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-skill-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync('AGENTS.md', '# Mine\n\n<!-- cleanlist-cli -->\nold: cleanlist agents run\n<!-- /cleanlist-cli -->\n\n## After\n');
    const run = () => cmd(skillCommands, 'skill').run({ opts: { target: 'agents' }, log() {} });
    assert.equal((await run()).written, true);
    const after = readFileSync('AGENTS.md', 'utf8');
    assert.ok(after.startsWith('# Mine\n') && after.endsWith('## After\n'), after);
    assert.ok(after.includes(SKILL_BODY) && !after.includes('old: cleanlist agents run'));
    assert.equal((await run()).written, false, 'a second run changes nothing');
    // The same with CRLF line endings (an AGENTS.md saved on Windows).
    writeFileSync('AGENTS.md', '# Mine\r\n\r\n<!-- cleanlist-cli -->\r\nold: cleanlist agents run\r\n<!-- /cleanlist-cli -->\r\n\r\n## After\r\n');
    assert.equal((await run()).written, true);
    const crlf = readFileSync('AGENTS.md', 'utf8');
    assert.ok(!crlf.includes('old: cleanlist agents run') && crlf.split('<!-- cleanlist-cli -->').length === 2, crlf);
    assert.ok(crlf.startsWith('# Mine\r\n') && crlf.endsWith('## After\r\n'), crlf);
    assert.equal((await run()).written, false, 'a second CRLF run changes nothing');
  } finally {
    process.chdir(cwd);
  }
});

test('actions run: a person-only card refused at confirm surfaces person_required', async () => {
  const refused = toError(403, { error: { code: 'person_required', problem: 'agents.set_status turns an agent on.' } });
  const ctx = fakeCtx(['lists.delete'], { yes: true }, { ...routes, 'POST /api/v2/actions/confirm': refused });
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => e.exitCode === EXIT.AUTH && e.apiCode === 'person_required');
});

// GTM agents

test('agents off sends status off; agents update PATCHes, and --schedule null removes the schedule', async () => {
  const off = fakeCtx(['a1'], {}, { 'POST /api/v2/gtm-agents/a1/status': { id: 'a1', status: 'paused' } });
  await cmd(agentCommands, 'agents off').run(off);
  assert.deepEqual(off.calls[0].body, { status: 'off' });

  const upd = fakeCtx(['a1'], { schedule: 'null' }, { 'PATCH /api/v2/gtm-agents/a1': { id: 'a1' } });
  await cmd(agentCommands, 'agents update').run(upd);
  assert.equal(JSON.stringify(upd.calls[0].body), '{"schedule":null}');
  await assert.rejects(cmd(agentCommands, 'agents update').run(fakeCtx(['a1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('agents list is GTM agents (a JSON array); the AI-column list is smart-agents list', async () => {
  const s = await server((req, res) =>
    req.url.startsWith('/api/v2/gtm-agents') ? send(res, 200, [{ id: 'a1', name: 'Inbound', status: 'paused' }]) : send(res, 200, { runs: [], total: 0 }),
  );
  try {
    const gtm = await runCli(['agents', 'list', '--json', '--api-url', s.url]);
    assert.equal(gtm.code, 0, gtm.stderr);
    assert.deepEqual(JSON.parse(gtm.stdout), [{ id: 'a1', name: 'Inbound', status: 'paused' }]);
    const ai = await runCli(['smart-agents', 'list', '--json', '--api-url', s.url]);
    assert.deepEqual(JSON.parse(ai.stdout), { runs: [], total: 0 });
    assert.deepEqual(s.hits, ['GET /api/v2/gtm-agents', 'GET /api/v2/smart-agents']);
  } finally {
    s.close();
  }
});

test('0.1.0 agent commands exit 2 and point at smart-agents; agents on says a person does it', async () => {
  for (const args of [['agents', 'run', 'Q4', '--column', 'Hook'], ['agents', 'results', 't1'], ['agents', 'list', '--list', 'Q4']]) {
    const r = await runCli(args);
    assert.equal(r.code, EXIT.USAGE, args.join(' '));
    assert.match(JSON.parse(r.stderr).error.fix, /smart-agents/, args.join(' '));
  }
  const on = await runCli(['agents', 'on', 'a1']);
  assert.equal(on.code, EXIT.USAGE);
  assert.match(JSON.parse(on.stderr).error.fix, /Cleanlist app/);
});

test('mergeCodexConfig leaves header-shaped text inside multiline strings alone', () => {
  const before = '[profiles.work]\nnotes = """\n[mcp_servers.cleanlist]\nkeep me\n"""\nlit = \'\'\'\n[mcp_servers.cleanlist]\n\'\'\'\n\n[mcp_servers.cleanlist]\nurl = "old"\n';
  const after = mergeCodexConfig(before, '[mcp_servers.cleanlist]\nurl = "new"\n');
  assert.ok(after.includes('notes = """\n[mcp_servers.cleanlist]\nkeep me\n"""'), after);
  assert.ok(after.includes("lit = '''\n[mcp_servers.cleanlist]\n'''"), after);
  assert.ok(after.endsWith('[mcp_servers.cleanlist]\nurl = "new"\n') && !after.includes('url = "old"'), after);
});
