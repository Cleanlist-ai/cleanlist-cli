import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { toError } from '../dist/api.js';
import { actionCommands } from '../dist/commands/actions.js';
import { agentCommands } from '../dist/commands/agents.js';
import { playCommands } from '../dist/commands/plays.js';
import { sequenceCommands } from '../dist/commands/sequences.js';
import { jsonOpt, sendApproved } from '../dist/context.js';
import { EXIT } from '../dist/errors.js';

const cmd = (list, name) => list.find((c) => c.name === name);
const quote = { quote_id: 'qte_1', estimated_cost: 40, available_credits: 1000, row_count: 1, sufficient: true, expires_at: 0, tool: 'x' };

/** A ctx whose API records every call and answers from `routes` (path → body or function). */
function fakeCtx(args, opts, routes) {
  const calls = [];
  const answer = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (r === undefined) throw new Error(`unexpected ${method} ${path}`);
    return { status: 200, data: typeof r === 'function' ? r(body) : r };
  };
  return {
    calls,
    args,
    opts: { 'no-input': true, ...opts },
    log() {},
    api: {
      get: (path) => answer('GET', path),
      post: (path, body) => answer('POST', path, body),
      request: (method, path, o = {}) => answer(method, path, o.body),
    },
  };
}

test('jsonOpt refuses bad JSON and non-objects', () => {
  assert.deepEqual(jsonOpt('{"a":1}', 'args'), { a: 1 });
  assert.equal(jsonOpt(undefined, 'args'), undefined);
  assert.throws(() => jsonOpt('{a:1}', 'args'), (e) => e.exitCode === EXIT.USAGE && /not valid JSON/.test(e.message));
  assert.throws(() => jsonOpt('[1]', 'args'), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => jsonOpt('null', 'args'), (e) => e.exitCode === EXIT.USAGE);
});

// actions
const card = {
  action: 'agents.set_status',
  session_id: 'ses_1',
  kind: 'card',
  card: { card_id: 'crd_1', title: 'Turn on agent', summary: 'Emails 12 people.', credits_required: 120, expires_at: '2026-11-10T00:00:00Z' },
};
const confirmed = { card_id: 'crd_1', status: 'done', result: { ok: true } };
const actionRoutes = { 'POST /api/v2/actions/agents.set_status': card, 'POST /api/v2/actions/confirm': confirmed };

test('actions run: a card without --yes and no TTY exits 7 with the card and confirms nothing', async () => {
  const ctx = fakeCtx(['agents.set_status'], { args: '{"agent_id":"a1"}' }, actionRoutes);
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => {
    assert.equal(e.exitCode, EXIT.CONFIRM);
    assert.equal(e.detail.card.card.card_id, 'crd_1');
    assert.match(e.fix, /actions confirm crd_1 --session ses_1/);
    return true;
  });
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/actions/agents.set_status']);
  assert.deepEqual(ctx.calls[0].body, { arguments: { agent_id: 'a1' }, session_id: undefined });
});

test('actions run: --yes confirms that card once with its session', async () => {
  const ctx = fakeCtx(['agents.set_status'], { yes: true, session: 'ses_1' }, actionRoutes);
  const out = await cmd(actionCommands, 'actions run').run(ctx);
  assert.equal(out.status, 'done');
  assert.deepEqual(ctx.calls[1], { method: 'POST', path: '/api/v2/actions/confirm', body: { card_id: 'crd_1', session_id: 'ses_1' } });
});

test('actions run: a card above --max-credits exits 5 even with --yes', async () => {
  const ctx = fakeCtx(['agents.set_status'], { yes: true, 'max-credits': '100' }, actionRoutes);
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => e.exitCode === EXIT.CREDITS);
  assert.equal(ctx.calls.length, 1);
});

test('actions run: a plain result is returned as is; --dry-run and bad --args are refused before any call', async () => {
  const result = { action: 'agents.get', session_id: 'ses_1', kind: 'result', result: { id: 'a1' } };
  const ctx = fakeCtx(['agents.get'], {}, { 'POST /api/v2/actions/agents.get': result });
  assert.deepEqual(await cmd(actionCommands, 'actions run').run(ctx), result);
  for (const opts of [{ 'dry-run': true }, { args: 'nope' }]) {
    const c = fakeCtx(['agents.get'], opts, {});
    await assert.rejects(cmd(actionCommands, 'actions run').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('actions confirm needs --session', async () => {
  await assert.rejects(cmd(actionCommands, 'actions confirm').run(fakeCtx(['crd_1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

// paid runs
test('agents run quotes run_gtm_agent and sends the quote_id; without --yes nothing runs', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/gtm-agents/a1/run': { run_id: 'run_1' } };
  const ctx = fakeCtx(['a1'], { yes: true, play: 'pb_1' }, routes);
  assert.deepEqual(await cmd(agentCommands, 'agents run').run(ctx), { run_id: 'run_1' });
  assert.deepEqual(ctx.calls[0].body, { tool: 'run_gtm_agent', agent_id: 'a1', playbook_id: 'pb_1' });
  assert.deepEqual(ctx.calls[1].body, { playbook_id: 'pb_1', quote_id: 'qte_1' });

  const refused = fakeCtx(['a1'], {}, routes);
  await assert.rejects(cmd(agentCommands, 'agents run').run(refused), (e) => e.exitCode === EXIT.CONFIRM);
  assert.equal(refused.calls.length, 1);
});

test('plays run quotes one row of run_play and passes the inputs', async () => {
  const routes = { 'POST /api/v2/credits/estimate': quote, 'POST /api/v2/plays/pb_1/run': { run_id: 'run_1' } };
  const ctx = fakeCtx(['pb_1'], { yes: true, inputs: '{"email":"jane@acme.com"}' }, routes);
  await cmd(playCommands, 'plays run').run(ctx);
  assert.deepEqual(ctx.calls[0].body, { tool: 'run_play', playbook_id: 'pb_1', row_count: 1 });
  assert.deepEqual(ctx.calls[1].body, { inputs: { email: 'jane@acme.com' }, quote_id: 'qte_1' });
});

test('agents update needs a field to change', async () => {
  await assert.rejects(cmd(agentCommands, 'agents update').run(fakeCtx(['a1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

// approvals
const approvalNeeded = () => {
  throw toError(409, { error: { code: 'approval_required', problem: 'This emails 12 people in "Q4 ABM".' } });
};

test('sendApproved: without --yes a 409 approval_required exits 7 with the summary and never sends approved', async () => {
  const ctx = fakeCtx([], {}, { 'POST /s': (b) => (b.approved ? { ok: true } : approvalNeeded()) });
  await assert.rejects(sendApproved(ctx, '/s', { status: 'launch' }), (e) => e.exitCode === EXIT.CONFIRM && /12 people/.test(e.message));
  assert.deepEqual(ctx.calls.map((c) => c.body.approved), [false]);
});

test('sendApproved: --yes sends approved true; a call needing no approval just runs', async () => {
  const yes = fakeCtx([], { yes: true }, { 'POST /s': { ok: true } });
  await sendApproved(yes, '/s', { status: 'launch' });
  assert.deepEqual(yes.calls[0].body, { status: 'launch', approved: true });
  const pause = fakeCtx([], {}, { 'POST /s': { ok: true } });
  assert.deepEqual(await sendApproved(pause, '/s', { status: 'pause' }), { ok: true });
});

test('sendApproved: other API errors pass through; --dry-run is refused', async () => {
  const ctx = fakeCtx([], {}, { 'POST /s': () => { throw toError(404, {}); } });
  await assert.rejects(sendApproved(ctx, '/s', {}), (e) => e.exitCode === EXIT.NOT_FOUND);
  await assert.rejects(sendApproved(fakeCtx([], { 'dry-run': true }, {}), '/s', {}), (e) => e.exitCode === EXIT.USAGE);
});

test('sequences enroll takes exactly one of --leads and --list; status must be launch, pause or resume', async () => {
  const enroll = cmd(sequenceCommands, 'sequences enroll');
  await assert.rejects(enroll.run(fakeCtx(['s1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
  await assert.rejects(enroll.run(fakeCtx(['s1'], { leads: ['l1'], list: 'x' }, {})), (e) => e.exitCode === EXIT.USAGE);
  await assert.rejects(cmd(sequenceCommands, 'sequences status').run(fakeCtx(['s1', 'delete'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

// end to end through the binary: exit 7 puts the card on stdout
test('cli: actions run with a card exits 7 and prints the card on stdout', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v2/actions/agents.set_status') return res.end(JSON.stringify(card));
    res.statusCode = 500;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(process.execPath, ['dist/cli.js', 'actions', 'run', 'agents.set_status', '--args', '{}', '--api-url', url, '--json'], {
      env: { ...process.env, CLEANLIST_API_KEY: 'test', CI: '1' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, EXIT.CONFIRM);
    assert.equal(JSON.parse(stdout).card.card_id, 'crd_1');
  } finally {
    server.close();
  }
});
