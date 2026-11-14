import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Api, retryDelayMs } from '../dist/api.js';
import { batchCommands, parseItems } from '../dist/commands/batch.js';
import { completionScript } from '../dist/commands/completion.js';
import { eventCommands, signature, sinceOpt } from '../dist/commands/events.js';
import { codexBlock, desktopConfigPath, lineDiff, MCP_URL } from '../dist/commands/mcp.js';
import { decodeFrames, encodeFrame } from '../dist/ws.js';
import { EXIT } from '../dist/errors.js';
import { quote as baseQuote, runCli } from './helpers.mjs';

const cmd = (list, name) => list.find((c) => c.name === name);
const quote = { ...baseQuote, row_count: 2 };

/** Close a test server and every socket on it (keep-alive and upgraded ones too). */
function hardClose(server) {
  for (const s of server.sockets ?? []) s.destroy();
  server.closeAllConnections?.();
  server.close();
}

function track(server) {
  server.sockets = new Set();
  server.on('connection', (s) => (server.sockets.add(s), s.on('close', () => server.sockets.delete(s))));
  return server;
}

async function serve(handler) {
  const server = track(createServer(handler));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const run = (args, env = {}, input) => runCli(args, { env: { CLEANLIST_API_KEY: '', ...env }, input });

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

// retries and idempotency (C12.7)

test('api: a write retries a 429 with the same Idempotency-Key, honoring retry_after_ms', async () => {
  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push(req.headers['idempotency-key']);
    if (seen.length === 1) return json(res, 429, { error: { code: 'rate_limited', retry_after_ms: 5 } }, { 'retry-after': '1' });
    json(res, 200, { ok: true });
  });
  try {
    const out = await new Api(url, { type: 'api_key', key: 'k' }, 'p', false).post('/api/v2/x', {});
    assert.deepEqual(out.data, { ok: true });
    assert.equal(seen.length, 2);
    assert.match(seen[0], /^[0-9a-f-]{36}$/);
    assert.equal(seen[0], seen[1]);
  } finally {
    hardClose(server);
  }
});

test('api: each write gets a fresh key, and reads send none', async () => {
  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push([req.method, req.headers['idempotency-key']]);
    json(res, 200, {});
  });
  try {
    const api = new Api(url, { type: 'api_key', key: 'k' }, 'p', false);
    await api.post('/api/v2/x', {});
    await api.post('/api/v2/x', {});
    await api.get('/api/v2/x');
    await api.request('DELETE', '/api/v2/x');
    assert.notEqual(seen[0][1], seen[1][1]);
    assert.equal(seen[2][1], undefined);
    assert.ok(seen[3][1]);
  } finally {
    hardClose(server);
  }
});

test('api: 5xx and idempotency_in_progress retry; gives up after 3 tries with the last error', async () => {
  let n = 0;
  const { server, url } = await serve((req, res) => {
    n++;
    if (n === 1) return json(res, 409, { error: { code: 'idempotency_in_progress', retry_after_ms: 1 } });
    json(res, 500, { error: { code: 'internal', problem: 'boom', retry_after_ms: 1 } });
  });
  try {
    await assert.rejects(new Api(url, { type: 'api_key', key: 'k' }, 'p', false).post('/api/v2/x', {}), (e) => e.exitCode === EXIT.ERROR && e.message === 'boom');
    assert.equal(n, 3);
  } finally {
    hardClose(server);
  }
});

test('api: a quote-bound write retries a 429 but not a 5xx, which would resend a spent quote', async () => {
  let n = 0;
  const { server, url } = await serve((req, res) => {
    n++;
    if (n === 1) return json(res, 429, { error: { code: 'rate_limited', retry_after_ms: 1 } });
    json(res, 500, { error: { code: 'internal', problem: 'boom' } });
  });
  try {
    await assert.rejects(new Api(url, { type: 'api_key', key: 'k' }, 'p', false).post('/api/v2/x', { quote_id: 'qte_1' }), (e) => {
      assert.equal(e.exitCode, EXIT.ERROR);
      assert.match(e.fix, /may have run.*fresh quote/);
      return true;
    });
    assert.equal(n, 2);
  } finally {
    hardClose(server);
  }
});

test('cli: a closed stdout pipe (EPIPE) exits quietly', async () => {
  const child = spawn(process.execPath, ['dist/cli.js', 'completion', 'bash'], { env: { ...process.env, CI: '1' } });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.destroy();
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /EPIPE|Error/);
});

test('api: a Retry-After longer than a minute fails at once with exit 6', async () => {
  let n = 0;
  const { server, url } = await serve((req, res) => {
    n++;
    json(res, 429, { error: { code: 'rate_limited', problem: 'Slow down.' } }, { 'retry-after': '3600' });
  });
  try {
    await assert.rejects(new Api(url, { type: 'api_key', key: 'k' }, 'p', false).get('/api/v2/x'), (e) => e.exitCode === EXIT.RATE_LIMITED);
    assert.equal(n, 1);
  } finally {
    hardClose(server);
  }
});

test('api: a 4xx other than 429 is not retried', async () => {
  let n = 0;
  const { server, url } = await serve((req, res) => {
    n++;
    json(res, 422, { error: { code: 'idempotency_key_mismatch', problem: 'Different request.' } });
  });
  try {
    await assert.rejects(new Api(url, { type: 'api_key', key: 'k' }, 'p', false).post('/api/v2/x', {}), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(n, 1);
  } finally {
    hardClose(server);
  }
});

test('retryDelayMs: retry_after_ms, then Retry-After seconds or date, then backoff', () => {
  assert.equal(retryDelayMs(0, '9', { error: { retry_after_ms: 250 } }), 250);
  assert.equal(retryDelayMs(0, '2', {}), 2000);
  const d = retryDelayMs(0, new Date(Date.now() + 5000).toUTCString(), {});
  assert.ok(d > 3000 && d <= 5000, String(d));
  const b = retryDelayMs(2, null, undefined);
  assert.ok(b >= 3000 && b <= 5000, String(b));
});

test('api: Cleanlist-Mode: test flips mode and calls the notice once', async () => {
  const { server, url } = await serve((req, res) => json(res, 200, {}, { 'cleanlist-mode': 'test' }));
  try {
    let notices = 0;
    const api = new Api(url, { type: 'api_key', key: 'clapi_test_x' }, 'p', false, () => notices++);
    await api.get('/api/v2/x');
    await api.get('/api/v2/x');
    assert.equal(api.mode, 'test');
    assert.equal(notices, 1);
  } finally {
    hardClose(server);
  }
});

// profiles, use and test mode (C12.6, C12.8)

test('cli: login --test saves a test key beside the live one; --test uses it and shows TEST', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-dx-'));
  const env = { CLEANLIST_CONFIG_DIR: dir, CLEANLIST_NO_KEYCHAIN: '1' };
  const { server, url } = await serve((req, res) => {
    const test = req.headers.authorization === 'Bearer clapi_test_abc';
    json(res, 200, { organization_id: test ? 'org_sbx' : 'org_1', organization_name: 'Acme', user_email: 'a@acme.io', mode: test ? 'test' : 'live' }, test ? { 'cleanlist-mode': 'test' } : {});
  });
  try {
    assert.equal((await run(['login', '--api-key', 'clapi_live', '--api-url', url, '--profile', 'acme'], env)).code, 0);
    const bad = await run(['login', '--test', '--api-key', 'clapi_live', '--api-url', url, '--profile', 'acme'], env);
    assert.equal(bad.code, EXIT.USAGE);
    assert.equal((await run(['login', '--test', '--api-key', 'clapi_test_abc', '--api-url', url, '--profile', 'acme'], env)).code, 0);

    const creds = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'));
    assert.equal(creds.acme.key, 'clapi_live');
    assert.equal(creds['acme:test'].key, 'clapi_test_abc');
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).profiles.acme.organizationId, 'org_1');

    const live = await run(['whoami', '--profile', 'acme', '--json'], env);
    assert.equal(JSON.parse(live.stdout).mode, 'live');
    assert.doesNotMatch(live.stderr, /TEST/);
    const viaEnv = await run(['whoami', '--profile', 'acme', '--json'], { ...env, CLEANLIST_MODE: 'test' });
    assert.equal(JSON.parse(viaEnv.stdout).mode, 'test');
    assert.match(viaEnv.stderr, /TEST mode/);
  } finally {
    hardClose(server);
  }
});

test('cli: --test refuses a live key and a profile with no test key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-dx-'));
  const env = { CLEANLIST_CONFIG_DIR: dir, CLEANLIST_NO_KEYCHAIN: '1' };
  const live = await run(['whoami', '--test', '--api-url', 'http://127.0.0.1:9'], { ...env, CLEANLIST_API_KEY: 'clapi_live' });
  assert.equal(live.code, EXIT.USAGE);
  const none = await run(['whoami', '--test', '--api-url', 'http://127.0.0.1:9'], env);
  assert.equal(none.code, EXIT.AUTH);
  assert.match(none.stderr, /login --test/);
  assert.equal((await run(['whoami'], { ...env, CLEANLIST_MODE: 'sandbox' })).code, EXIT.USAGE);
});

test('cli: use switches the default profile; profiles marks the active one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-dx-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultProfile: 'a', profiles: { a: { organizationName: 'A' }, b: { organizationName: 'B' } } }));
  const env = { CLEANLIST_CONFIG_DIR: dir, CLEANLIST_PROFILE: '' };
  assert.equal((await run(['use', 'nope'], env)).code, EXIT.NOT_FOUND);
  assert.equal((await run(['use', 'b'], env)).code, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).defaultProfile, 'b');
  const rows = JSON.parse((await run(['profiles', '--json'], env)).stdout).profiles;
  assert.deepEqual(rows.map((r) => [r.name, r.active]), [['a', false], ['b', true]]);
  const flagged = JSON.parse((await run(['profiles', '--json', '--profile', 'a'], env)).stdout).profiles;
  assert.deepEqual(flagged.map((r) => r.active), [true, false]);
});

// listen (C12.1)

/** A WebSocket server speaking just enough RFC 6455 for listen: sends `frames`, then closes with `closeCode`. */
async function wsServer(frames, closeCode, onAuth) {
  const server = track(createServer());
  server.on('upgrade', (req, socket) => {
    onAuth?.(req);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (opcode, payload) => {
      const len = payload.length;
      const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
      socket.write(Buffer.concat([head, payload]));
    };
    send(0x9, Buffer.from('hi')); // a ping the client must answer
    for (const f of frames) send(0x1, Buffer.from(JSON.stringify(f)));
    setTimeout(() => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(closeCode);
      send(0x8, p);
    }, 300);
    socket.on('data', (d) => server.emit('client-frames', decodeFrames(d).frames));
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('ws: frames round-trip through encode (masked) and decode, including 16-bit lengths', () => {
  const big = Buffer.alloc(300, 'a');
  const { frames, rest } = decodeFrames(Buffer.concat([encodeFrame(1, Buffer.from('hello')), encodeFrame(1, big), encodeFrame(1, Buffer.from('cut')).subarray(0, 4)]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.toString(), 'hello');
  assert.equal(frames[1].payload.length, 300);
  assert.equal(rest.length, 4);
});

test('cli: listen prints each event once and forwards it signed with the session secret', async () => {
  const event = { id: 'evt_1', type: 'reply.received', created_at: '2026-11-10T00:00:00Z', organization_id: 'org_1', data: { thread_id: 't1' } };
  let auth;
  let pongs = 0;
  const ws = await wsServer(
    [{ type: 'listening', listener_id: 'lst_1', secret: 'whsec_abc', events: ['reply.received'], idle_timeout_seconds: 3600 }, { type: 'event', event }, { type: 'event', event }],
    1000,
    (req) => (auth = { header: req.headers.authorization, url: req.url }),
  );
  ws.server.on('client-frames', (fs) => (pongs += fs.filter((f) => f.opcode === 0xa).length));
  const forwards = [];
  const app = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      forwards.push({ body, sig: req.headers['cleanlist-signature'] });
      res.end('ok');
    });
  });
  try {
    const out = await run(['listen', '--events', 'reply.received', '--forward-to', `${app.url}/hook`, '--api-url', ws.url, '--json'], { CLEANLIST_API_KEY: 'clapi_k' });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(auth.header, 'Bearer clapi_k');
    assert.equal(auth.url, '/api/v2/events/listen?events=reply.received');
    assert.deepEqual(out.stdout.trim().split('\n').map((l) => JSON.parse(l).id), ['evt_1']);
    assert.match(out.stderr, /whsec_abc/);
    assert.equal(forwards.length, 1);
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(forwards[0].sig);
    assert.equal(v1, createHmac('sha256', 'whsec_abc').update(`${t}.${forwards[0].body}`).digest('hex'));
    assert.deepEqual(JSON.parse(forwards[0].body), event);
    assert.equal(pongs, 1);
  } finally {
    hardClose(ws.server);
    hardClose(app.server);
  }
});

test('cli: listen with a test key says TEST mode up front; a live key does not', async () => {
  const frames = [{ type: 'listening', listener_id: 'lst_1', secret: 'whsec_abc', events: [], idle_timeout_seconds: 3600 }];
  for (const [key, banner] of [['clapi_test_k', true], ['clapi_k', false]]) {
    const ws = await wsServer(frames, 1000);
    try {
      const out = await run(['listen', '--api-url', ws.url, '--json'], { CLEANLIST_API_KEY: key });
      assert.equal(out.code, 0, out.stderr);
      assert.equal(/TEST mode/.test(out.stderr), banner, key);
    } finally {
      hardClose(ws.server);
    }
  }
});

test('cli: listen turns a refusal frame and its 44xx close into the error and exit code', async () => {
  const ws = await wsServer([{ type: 'error', error: { code: 'forbidden', problem: 'Needs admin:api_keys.', fix: 'Use a key with admin:api_keys.' } }], 4403);
  try {
    const out = await run(['listen', '--api-url', ws.url, '--json'], { CLEANLIST_API_KEY: 'clapi_k' });
    assert.equal(out.code, EXIT.AUTH);
    assert.equal(JSON.parse(out.stderr).error.code, 'forbidden');
  } finally {
    hardClose(ws.server);
  }
});

test('listen: --forward-to must be an http(s) URL', async () => {
  const ctx = { args: [], opts: { 'forward-to': 'ftp://x' }, apiUrl: 'http://x', log() {}, api: { token: async () => 't' } };
  await assert.rejects(cmd(eventCommands, 'listen').run(ctx), (e) => e.exitCode === EXIT.USAGE);
});

test('signature matches the C4 format', () => {
  const v1 = createHmac('sha256', 's').update('17.{"a":1}').digest('hex');
  assert.equal(signature('s', '{"a":1}', 17), `t=17,v1=${v1}`);
});

// logs (C12.2)

test('sinceOpt takes an ISO time or a duration ago, and refuses junk', () => {
  assert.equal(sinceOpt('2026-11-10T14:00:00Z'), '2026-11-10T14:00:00Z');
  const ago = Date.now() - Date.parse(sinceOpt('2h'));
  assert.ok(Math.abs(ago - 7_200_000) < 5000);
  assert.throws(() => sinceOpt('yesterday'), (e) => e.exitCode === EXIT.USAGE);
  assert.equal(sinceOpt(undefined), undefined);
});

test('logs passes the filters through and refuses --follow with --cursor', async () => {
  const calls = [];
  const ctx = {
    args: [],
    opts: { status: '4xx', path: '/api/v2/lead-lists', limit: '10' },
    api: { get: async (path, q) => (calls.push({ path, q }), { status: 200, data: { logs: [], next_cursor: null } }) },
  };
  await cmd(eventCommands, 'logs').run(ctx);
  assert.equal(calls[0].path, '/api/v2/logs');
  assert.equal(calls[0].q.status, '4xx');
  assert.equal(calls[0].q.path, '/api/v2/lead-lists');
  await assert.rejects(cmd(eventCommands, 'logs').run({ ...ctx, opts: { follow: true, cursor: 'c' } }), (e) => e.exitCode === EXIT.USAGE);
});

test('logs --follow prints new rows oldest first, once each, across a repeated boundary row', async () => {
  const r = (id, time) => ({ id, time, method: 'GET', path: '/p', status: 200, duration_ms: 1, credits: 0 });
  const pages = [
    { logs: [r('2', 't2'), r('1', 't1')] }, // first page, newest first
    { logs: [r('3', 't3'), r('2', 't2')] }, // since=t2 repeats row 2
    { logs: [r('3', 't3')] },
  ];
  const queries = [];
  let n = 0;
  const ctx = {
    args: [],
    format: 'jsonl',
    opts: { follow: true },
    api: {
      get: async (_p, q) => {
        queries.push(q);
        const page = pages[Math.min(n++, pages.length - 1)];
        if (n === 3) setImmediate(() => process.emit('SIGINT'));
        return { status: 200, data: { ...page, next_cursor: null } };
      },
    },
  };
  const written = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...rest) => (typeof s === 'string' && s.startsWith('{"id"') ? (written.push(s), true) : orig(s, ...rest));
  try {
    await cmd(eventCommands, 'logs').run(ctx);
  } finally {
    process.stdout.write = orig;
  }
  assert.deepEqual(written.map((l) => JSON.parse(l).id), ['1', '2', '3']);
  assert.equal(queries[1].since, 't2');
  assert.equal(queries[2].since, 't3');
});

// batch (C12.9)

test('parseItems maps CSV headers, splits a full name and keeps row numbers for empty rows', () => {
  const csv = 'Work Email,Name,Website,Notes\njane@acme.io,,,x\n,Sam Lee,acme.io,\n,,,\n';
  assert.deepEqual(parseItems(csv, 'people'), [{ email: 'jane@acme.io' }, { first_name: 'Sam', last_name: 'Lee', domain: 'acme.io' }, {}]);
  assert.deepEqual(parseItems('domain\nacme.io\n', 'companies'), [{ domain: 'acme.io' }]);
  assert.throws(() => parseItems('notes\nx\n', 'companies'), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseItems('', 'people'), (e) => e.exitCode === EXIT.USAGE);
});

test('parseItems reads a JSON array, {items}, and JSON Lines', () => {
  assert.deepEqual(parseItems('[{"email":"a@x.io","domain":""}]', 'people'), [{ email: 'a@x.io' }]);
  assert.deepEqual(parseItems('{"items":[{"domain":"x.io"}]}', 'companies'), [{ domain: 'x.io' }]);
  assert.deepEqual(parseItems('{"domain":"a.io"}\n{"domain":"b.io"}\n', 'companies'), [{ domain: 'a.io' }, { domain: 'b.io' }]);
  assert.throws(() => parseItems('{"domain":', 'companies'), (e) => e.exitCode === EXIT.USAGE);
});

function batchCtx(file, opts, routes) {
  const calls = [];
  const answer = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (r === undefined) throw new Error(`unexpected ${method} ${path}`);
    return { status: 200, data: typeof r === 'function' ? r(body) : r };
  };
  return {
    calls,
    args: [file],
    opts: { 'no-input': true, ...opts },
    log() {},
    api: { get: (path, q) => answer('GET', path, q), post: (path, body) => answer('POST', path, body) },
  };
}

const tmpFile = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cl-dx-')), 'in.csv');
  writeFileSync(p, text);
  return p;
};

test('batch people: one quote for the batch, then the lookup with its quote_id', async () => {
  const file = tmpFile('email\na@x.io\nb@x.io\n');
  const started = { task_id: 'tsk_1', status: 'pending', total_rows: 2, accepted_rows: 2, rows: [{ row: 0, status: 'queued' }, { row: 1, status: 'queued' }] };
  const ctx = batchCtx(file, { yes: true, fields: ['email,phone'] }, { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/batch/people/lookup': started });
  await cmd(batchCommands, 'batch people').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'batch_people_lookup', row_count: 2, fields: ['email', 'phone'] });
  assert.deepEqual(ctx.calls[1].body, { items: [{ email: 'a@x.io' }, { email: 'b@x.io' }], fields: ['email', 'phone'], quote_id: 'qte_1', lead_list_id: undefined });
});

test('batch people: without --yes and no TTY exits 7 and runs nothing; bad --fields and >1,000 rows refuse first', async () => {
  const file = tmpFile('email\na@x.io\n');
  const ctx = batchCtx(file, {}, { 'POST /api/v2/credits/estimate': quote });
  await assert.rejects(cmd(batchCommands, 'batch people').run(ctx), (e) => e.exitCode === EXIT.CONFIRM);
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/credits/estimate']);

  await assert.rejects(cmd(batchCommands, 'batch people').run(batchCtx(file, { fields: ['mobile'] }, {})), (e) => e.exitCode === EXIT.USAGE);
  const big = tmpFile('email\n' + Array.from({ length: 1001 }, (_, i) => `p${i}@x.io`).join('\n'));
  await assert.rejects(cmd(batchCommands, 'batch people').run(batchCtx(big, { yes: true }, {})), (e) => e.exitCode === EXIT.USAGE && /1000-row/.test(e.message));
});

test('batch people --wait: waits on the workflow and returns its per-person results', async () => {
  const file = tmpFile('email\na@x.io\nnot-an-email\n');
  const started = { task_id: 'tsk_1', workflow_id: 'wf_1', status: 'pending', total_rows: 2, accepted_rows: 1, rows: [{ row: 0, status: 'queued' }, { row: 1, status: 'invalid', error: 'bad email' }] };
  const ctx = batchCtx(file, { yes: true, wait: true }, {
    'POST /api/v2/credits/estimate': quote,
    'POST /api/v2/batch/people/lookup': started,
    'GET /api/v2/enrichment/status/wf_1': { status: 'completed', results: [{ email: 'a@x.io' }] },
  });
  const out = await cmd(batchCommands, 'batch people').run(ctx);
  assert.equal(out.enrichment.results[0].email, 'a@x.io');
  assert.equal(out.rows[1].status, 'invalid');
  assert.deepEqual(ctx.calls[2].body, { include_results: true });
});

test('batch companies: quotes batch_companies_lookup and posts the items', async () => {
  const file = tmpFile('Website\nacme.io\n');
  const ctx = batchCtx(file, { yes: true }, { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/batch/companies/lookup': { status: 'completed', total_rows: 1, accepted_rows: 1, rows: [] } });
  await cmd(batchCommands, 'batch companies').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'batch_companies_lookup', row_count: 1 });
  assert.deepEqual(ctx.calls[1].body, { items: [{ domain: 'acme.io' }], quote_id: 'qte_1' });
});

test('cli: batch reads stdin with -', async () => {
  const { server, url } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => json(res, 200, req.url === '/api/v2/credits/estimate' ? { ...quote, row_count: JSON.parse(body).row_count } : {}));
  });
  try {
    const { code, stdout } = await runCli(['batch', 'companies', '-', '--dry-run', '--api-url', url, '--json'], { env: { CLEANLIST_API_KEY: 'k' }, input: 'domain\na.io\nb.io\nc.io\n' });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).row_count, 3);
  } finally {
    hardClose(server);
  }
});

// mcp install (C12.4)

test('lineDiff marks added and removed lines', () => {
  assert.equal(lineDiff('a\nb\n', 'a\nc\n'), '  a\n+ c\n- b\n');
  assert.equal(lineDiff('', 'x\n'), '+ x\n');
});

test('cli: mcp install shows the diff, writes nothing without --yes, then writes with it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cl-home-'));
  const env = { HOME: home };
  const dry = await run(['mcp', 'install', 'cursor', '--api-key', 'clapi_secretkey1234'], env);
  assert.equal(dry.code, EXIT.CONFIRM);
  assert.match(dry.stderr, /\+ +"cleanlist"/);
  assert.doesNotMatch(dry.stderr, /clapi_secretkey1234/);
  assert.throws(() => readFileSync(join(home, '.cursor', 'mcp.json')));

  assert.equal((await run(['mcp', 'install', 'cursor', '--yes'], env)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.cleanlist, { url: MCP_URL });

  assert.equal((await run(['mcp', 'install', 'codex', '--api-key', 'clapi_k', '--yes'], env)).code, 0);
  assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /CLEANLIST_API_KEY = "clapi_k"/);

  assert.equal((await run(['mcp', 'install', 'vscode'], env)).code, EXIT.USAGE);
  assert.equal((await run(['mcp', 'install', 'cursor', '--api-key', 'nope'], env)).code, EXIT.USAGE);
  assert.equal((await run(['mcp', 'install', 'cursor', '--api-key', 'clapi_k', '--oauth'], env)).code, EXIT.USAGE);
});

test('cli: mcp install --api-key - reads the piped key, and a key goes into an existing config only at mode 0600', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cl-home-'));
  const path = join(home, '.cursor', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"mcpServers":{"other":{"command":"x"}}}\n', { mode: 0o644 });
  const out = await run(['mcp', 'install', 'cursor', '--api-key', '-', '--yes'], { HOME: home }, 'clapi_piped1234\n');
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers.cleanlist.env.CLEANLIST_API_KEY, 'clapi_piped1234');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal((await run(['mcp', 'install', 'cursor', '--api-key', '-', '--yes'], { HOME: home }, 'nope\n')).code, EXIT.USAGE);
});

test('cli: mcp install masks a key already in the config, in an oauth or a new-key install', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cl-home-'));
  const old = 'clapi_live_oldsecret5678';
  const cursor = join(home, '.cursor', 'mcp.json');
  const codex = join(home, '.codex', 'config.toml');
  for (const p of [cursor, codex]) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(cursor, JSON.stringify({ mcpServers: { cleanlist: { command: 'npx', env: { CLEANLIST_API_KEY: old } } } }));
  writeFileSync(codex, codexBlock(old));
  for (const args of [['cursor'], ['cursor', '--api-key', 'clapi_live_newsecret9999'], ['codex', '--yes'], ['claude-desktop']]) {
    if (args[0] === 'claude-desktop') {
      const path = desktopConfigPath(process.platform, home, {});
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ mcpServers: { cleanlist: { command: 'npx', env: { CLEANLIST_API_KEY: old } } } }));
    }
    const out = await run(['mcp', 'install', ...args], { HOME: home });
    assert.match(out.stderr, /^- .*clapi_live…5678/m, args.join(' '));
    assert.doesNotMatch(out.stderr + out.stdout, /oldsecret|newsecret/, args.join(' '));
  }
});

test('cli: mcp install on a compact JSON config shows only the cleanlist lines as new', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cl-home-'));
  const path = join(home, '.cursor', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"mcpServers":{"other":{"command":"x"}}}');
  const out = await run(['mcp', 'install', 'cursor'], { HOME: home });
  assert.equal(out.code, EXIT.CONFIRM);
  assert.match(out.stderr, /^ {2}\s+"other": \{$/m);
  assert.doesNotMatch(out.stderr, /^\+ .*"other"/m);
  assert.match(out.stderr, /^\+ +"cleanlist"/m);
});

// completion (C12.5)

test('completion scripts cover commands and subcommands, and bash parses them', () => {
  const commands = [
    { name: 'lists', summary: 'List lists.' },
    { name: 'lists rows', summary: "Read a list's rows.", options: { all: { type: 'boolean', desc: 'Every page.' } } },
    { name: 'listen', summary: 'Stream events.' },
  ];
  const global = { json: { type: 'boolean', desc: 'JSON.' } };
  const b = completionScript('bash', commands, global);
  assert.match(b, /lists\) words="rows"/);
  assert.match(b, /"lists rows"\) flags="--json --all"/);
  execFileSync('bash', ['-n'], { input: b });
  assert.match(completionScript('zsh', commands, global), /bashcompinit/);
  const f = completionScript('fish', commands, global);
  assert.match(f, /__fish_seen_subcommand_from lists' -a rows -d 'Read a list\\'s rows\.'/);
  assert.throws(() => completionScript('pwsh', commands, global), (e) => e.exitCode === EXIT.USAGE);
});

test('cli: completion bash includes the real command tree', async () => {
  const out = await run(['completion', 'bash']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /batch\) words="people companies"/);
  assert.match(out.stdout, /mcp\) words="install"/);
  execFileSync('bash', ['-n'], { input: out.stdout });
});
