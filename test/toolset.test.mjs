import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toError } from '../dist/api.js';
import { actionCommands } from '../dist/commands/actions.js';
import { agentCommands } from '../dist/commands/agents.js';
import { inboxCommands } from '../dist/commands/inbox.js';
import { playCommands } from '../dist/commands/plays.js';
import { sequenceCommands } from '../dist/commands/sequences.js';
import { taskCommands } from '../dist/commands/tasks.js';
import { updateCommands } from '../dist/commands/updates.js';
import { commit, jsonArray, jsonOpt, requireArg } from '../dist/context.js';
import { EXIT } from '../dist/errors.js';
import { fakeCtx, quote, runCli } from './helpers.mjs';

const cmd = (list, name) => list.find((c) => c.name === name);
test('jsonOpt refuses bad JSON and non-objects', () => {
  assert.deepEqual(jsonOpt('{"a":1}', 'args'), { a: 1 });
  assert.equal(jsonOpt(undefined, 'args'), undefined);
  assert.throws(() => jsonOpt('{a:1}', 'args'), (e) => e.exitCode === EXIT.USAGE && /not valid JSON/.test(e.message));
  assert.throws(() => jsonOpt('[1]', 'args'), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => jsonOpt('null', 'args'), (e) => e.exitCode === EXIT.USAGE);
});

test('jsonArray takes a non-empty array of objects and refuses the rest with the same parse error as jsonOpt', () => {
  assert.deepEqual(jsonArray('[{"a":1}]', 'changes'), [{ a: 1 }]);
  assert.equal(jsonArray(undefined, 'changes'), undefined);
  assert.throws(() => jsonArray('{a:1}', 'changes'), (e) => e.exitCode === EXIT.USAGE && /^--changes is not valid JSON/.test(e.message));
  for (const v of ['[]', '[1]', '[null]', '[[]]', '{"a":1}']) assert.throws(() => jsonArray(v, 'changes'), (e) => e.exitCode === EXIT.USAGE && /JSON array of objects/.test(e.message));
});

test('requireArg exits 2 naming the argument, with a fix only when there is a list to look in', () => {
  assert.equal(requireArg({ args: ['a1'] }, 'agent id', 'agents list'), 'a1');
  assert.throws(() => requireArg({ args: [] }, 'agent id', 'agents list'), (e) => e.exitCode === EXIT.USAGE && e.message === 'Pass the agent id.' && e.fix === 'See `cleanlist agents list`.');
  assert.throws(() => requireArg({ args: [''] }, 'run_id'), (e) => e.exitCode === EXIT.USAGE && e.fix === undefined);
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

test('actions run: a card above --max-credits exits 5 even with --yes', async () => {
  const ctx = fakeCtx(['agents.set_status'], { yes: true, 'max-credits': '100' }, actionRoutes);
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => e.exitCode === EXIT.CREDITS && /120 credits/.test(e.message) && e.fix === 'Raise --max-credits, or narrow the job.');
  assert.equal(ctx.calls.length, 1);
});

test('actions run: a non-numeric --max-credits exits 2 and never confirms the card', async () => {
  const ctx = fakeCtx(['agents.set_status'], { yes: true, 'max-credits': '1,000' }, actionRoutes);
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => e.exitCode === EXIT.USAGE);
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/actions/agents.set_status']);
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

test('actions run: an error result exits non-zero with the error; a failed confirm does too', async () => {
  const failed = { action: 'agents.get', session_id: 'ses_1', kind: 'result', result: { error: 'not_found', message: 'No such agent.' } };
  const ctx = fakeCtx(['agents.get'], {}, { 'POST /api/v2/actions/agents.get': failed });
  await assert.rejects(cmd(actionCommands, 'actions run').run(ctx), (e) => {
    assert.equal(e.exitCode, EXIT.ERROR);
    assert.equal(e.message, 'No such agent.');
    assert.equal(e.apiCode, 'not_found');
    assert.equal(e.detail.session_id, 'ses_1');
    return true;
  });
  const broke = fakeCtx(['agents.set_status'], { yes: true }, { ...actionRoutes, 'POST /api/v2/actions/confirm': { card_id: 'crd_1', status: 'failed', result: { error: 'insufficient_credits' } } });
  await assert.rejects(cmd(actionCommands, 'actions run').run(broke), (e) => e.exitCode === EXIT.CREDITS && e.message === 'insufficient_credits');
});

test('actions run: a card with no credit estimate still shows and confirms', async () => {
  const ctx = fakeCtx(['agents.set_status'], { yes: true, 'max-credits': '10' }, { ...actionRoutes, 'POST /api/v2/actions/agents.set_status': { ...card, card: { ...card.card, credits_required: null } } });
  assert.equal((await cmd(actionCommands, 'actions run').run(ctx)).status, 'done');
});

test('actions confirm needs --session', async () => {
  await assert.rejects(cmd(actionCommands, 'actions confirm').run(fakeCtx(['crd_1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

// live runs: preview, quote, commit (cleanse-api #2938 row 1)
const preview = (action, estimate, extra = {}) => ({
  committed: false,
  action,
  description: 'Runs Inbound follow-up on up to 25 people.',
  credits_max: 40,
  records_max: 25,
  effects: ['sends'],
  required_scopes: ['sequences:write'],
  missing_scopes: [],
  estimate,
  ...extra,
});
const runQuote = { ...quote, effects: ['sends'], required_scopes: ['sequences:write'] };
/** A live route: a preview without commit, `result` with it. */
const live = (action, estimate, result, extra) => (b) => (b.commit ? result : preview(action, estimate, extra));

test('agents run: preview, then the quote it names, then the run with quote_id and commit', async () => {
  const estimate = { tool: 'run_gtm_agent', agent_id: 'a1', playbook_id: 'pb_1' };
  const routes = { 'POST /api/v2/credits/estimate': runQuote, 'POST /api/v2/gtm-agents/a1/runs': live('run_gtm_agent', estimate, { run_id: 'run_1' }) };
  const ctx = fakeCtx(['a1'], { yes: true, play: 'pb_1' }, routes);
  assert.deepEqual(await cmd(agentCommands, 'agents run').run(ctx), { run_id: 'run_1' });
  assert.deepEqual(ctx.calls.map((c) => c.body), [
    { playbook_id: 'pb_1' },
    estimate,
    { playbook_id: 'pb_1', quote_id: 'qte_1', commit: true },
  ]);
});

test('agents run without --yes exits 7 with the quote saying what the run can do, and never commits', async () => {
  const routes = { 'POST /api/v2/credits/estimate': runQuote, 'POST /api/v2/gtm-agents/a1/runs': live('run_gtm_agent', { tool: 'run_gtm_agent', agent_id: 'a1' }, { run_id: 'run_1' }) };
  const ctx = fakeCtx(['a1'], {}, routes);
  await assert.rejects(cmd(agentCommands, 'agents run').run(ctx), (e) => {
    assert.equal(e.exitCode, EXIT.CONFIRM);
    assert.match(e.message, /can email people/);
    assert.equal(e.detail.quote.quote_id, 'qte_1');
    return true;
  });
  assert.ok(ctx.calls.every((c) => !c.body?.commit));
});

test('agents on: a key missing the opt-in scope stops after the preview, before any quote', async () => {
  const estimate = { tool: 'agent_on', agent_id: 'a1' };
  const routes = { 'POST /api/v2/gtm-agents/a1/status': live('agent_on', estimate, { id: 'a1', status: 'active' }, { effects: ['sends', 'crm_writes'], missing_scopes: ['crm:write'] }) };
  const ctx = fakeCtx(['a1'], { yes: true }, routes);
  await assert.rejects(cmd(agentCommands, 'agents on').run(ctx), (e) => e.exitCode === EXIT.AUTH && /"crm:write"/.test(e.message) && /tick crm:write/.test(e.fix));
  assert.deepEqual(ctx.calls.map((c) => c.path), ['/api/v2/gtm-agents/a1/status']);
  assert.deepEqual(ctx.calls[0].body, { status: 'on' });
});

test('agents on --yes turns it on with an agent_on quote; --dry-run prints the quote and commits nothing', async () => {
  const estimate = { tool: 'agent_on', agent_id: 'a1' };
  const routes = { 'POST /api/v2/credits/estimate': runQuote, 'POST /api/v2/gtm-agents/a1/status': live('agent_on', estimate, { id: 'a1', status: 'active' }) };
  const ctx = fakeCtx(['a1'], { yes: true }, routes);
  assert.equal((await cmd(agentCommands, 'agents on').run(ctx)).status, 'active');
  assert.deepEqual(ctx.calls[1].body, estimate);
  assert.deepEqual(ctx.calls[2].body, { status: 'on', quote_id: 'qte_1', commit: true });
  const dry = fakeCtx(['a1'], { 'dry-run': true }, routes);
  await assert.rejects(cmd(agentCommands, 'agents on').run(dry), (e) => e.constructor.name === 'DryRun' && e.output.quote_id === 'qte_1');
  assert.ok(dry.calls.every((c) => !c.body?.commit));
});

test('plays run: previews with the inputs, quotes run_play, runs with commit', async () => {
  const estimate = { tool: 'run_play', playbook_id: 'pb_1' };
  const routes = { 'POST /api/v2/credits/estimate': runQuote, 'POST /api/v2/plays/pb_1/runs': live('run_play', estimate, { run_id: 'run_1', queued: false, event_id: 'ev_1' }) };
  const ctx = fakeCtx(['pb_1'], { yes: true, inputs: '{"email":"jane@acme.com"}' }, routes);
  await cmd(playCommands, 'plays run').run(ctx);
  assert.deepEqual(ctx.calls.map((c) => c.body), [{ inputs: { email: 'jane@acme.com' } }, estimate, { inputs: { email: 'jane@acme.com' }, quote_id: 'qte_1', commit: true }]);
});

test('plays event reads a queued record by play and event id', async () => {
  const ctx = fakeCtx(['pb_1', 'ev_1'], {}, { 'GET /api/v2/plays/pb_1/events/ev_1': { event_id: 'ev_1', status: 'seeded', run_id: 'run_1' } });
  assert.equal((await cmd(playCommands, 'plays event').run(ctx)).run_id, 'run_1');
  await assert.rejects(cmd(playCommands, 'plays event').run(fakeCtx(['pb_1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('agents update needs a field to change', async () => {
  await assert.rejects(cmd(agentCommands, 'agents update').run(fakeCtx(['a1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

// sends and CRM writes: preview without commit (cleanse-api #2938 row 2)
const held = { committed: false, action: 'tasks.complete', preview: { effect: 'crm_write', summary: 'Logs a call on Jane Doe in HubSpot.', crm: 'HubSpot' } };

test('commit: without --yes a preview exits 7 with its summary and never commits', async () => {
  const ctx = fakeCtx([], {}, { 'POST /s': (b) => (b.commit ? { ok: true } : held) });
  await assert.rejects(commit(ctx, async (c) => (await ctx.api.post('/s', { commit: c })).data), (e) => e.exitCode === EXIT.CONFIRM && /HubSpot/.test(e.message) && e.detail.preview === held);
  assert.deepEqual(ctx.calls.map((c) => c.body.commit), [false]);
});

test('commit: --yes commits at once; a change that leaves Cleanlist alone just runs; --dry-run is refused', async () => {
  const yes = fakeCtx([], { yes: true }, { 'POST /s': (b) => b });
  assert.deepEqual(await commit(yes, async (c) => (await yes.api.post('/s', { commit: c })).data), { commit: true });
  const plain = fakeCtx([], {}, { 'POST /s': { id: 't1', status: 'done' } });
  assert.deepEqual(await commit(plain, async (c) => (await plain.api.post('/s', { commit: c })).data), { id: 't1', status: 'done' });
  assert.equal(plain.calls.length, 1);
  await assert.rejects(commit(fakeCtx([], { 'dry-run': true }, {}), async () => ({})), (e) => e.exitCode === EXIT.USAGE);
});

// sequences, through the sequences.* actions
const seqCard = (action) => ({ action, session_id: 'ses_1', kind: 'card', card: { card_id: 'crd_9', title: 'Edit', summary: 'Changes step 2.', credits_required: null, expires_at: 'x' } });

test('sequences status maps launch to activate and goes through the card; enroll needs --list', async () => {
  const ctx = fakeCtx(['s1', 'launch'], { yes: true }, { 'POST /api/v2/actions/sequences.set_status': seqCard('sequences.set_status'), 'POST /api/v2/actions/confirm': confirmed });
  await cmd(sequenceCommands, 'sequences status').run(ctx);
  assert.deepEqual(ctx.calls[0].body.arguments, { sequence_id: 's1', action: 'activate' });
  assert.deepEqual(ctx.calls[1].body, { card_id: 'crd_9', session_id: 'ses_1' });
  await assert.rejects(cmd(sequenceCommands, 'sequences enroll').run(fakeCtx(['s1'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
  await assert.rejects(cmd(sequenceCommands, 'sequences status').run(fakeCtx(['s1', 'delete'], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('sequences edit sends changes, name and writing to sequences.edit; refuses bad or empty edits before any call', async () => {
  const edit = cmd(sequenceCommands, 'sequences edit');
  const changes = [{ op: 'update', step_id: 'st_1', subject: 'Hi' }];
  const ctx = fakeCtx(['s1'], { changes: JSON.stringify(changes), name: 'v2' }, { 'POST /api/v2/actions/sequences.edit': seqCard('sequences.edit') });
  await assert.rejects(edit.run(ctx), (e) => e.exitCode === EXIT.CONFIRM);
  assert.deepEqual(ctx.calls[0].body.arguments, { sequence_id: 's1', changes, name: 'v2', writing: undefined });
  for (const opts of [{}, { changes: '{"op":"add"}' }, { changes: '[]' }, { changes: '[1]' }, { changes: 'nope' }, { writing: '[1]' }, { changes: '[{"op":"add","kind":"email"}]' }]) {
    const c = fakeCtx(['s1'], opts, {});
    await assert.rejects(edit.run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('sequences list and get read through their actions', async () => {
  const ctx = fakeCtx([], { status: 'active' }, { 'POST /api/v2/actions/sequences.list': { action: 'sequences.list', session_id: 's', kind: 'result', result: { sequences: [] } } });
  await cmd(sequenceCommands, 'sequences list').run(ctx);
  assert.deepEqual(ctx.calls[0].body.arguments, { query: '', status: 'active' });
});

// agents-rest responses: bare arrays, camelCase runs, run_id null when queued
test('agents list, agents runs and plays list read bare arrays', () => {
  const agents = [{ id: 'a1', name: 'Inbound', status: 'active' }];
  assert.deepEqual(cmd(agentCommands, 'agents list').view.rows(agents), agents);
  assert.ok(cmd(agentCommands, 'agents runs').view.columns.includes('recordsTotal'));
  assert.deepEqual(cmd(playCommands, 'plays list').view.rows([{ playbook_id: 'pb_1' }]), [{ playbook_id: 'pb_1' }]);
});

test('agents run --wait on a queued run returns without polling; plays run --wait asks for outputs', async () => {
  const queued = { run_id: null, queued: true, message: 'Waits for the CRM scan.' };
  const a = fakeCtx(['a1'], { yes: true, wait: true }, { 'POST /api/v2/credits/estimate': runQuote, 'POST /api/v2/gtm-agents/a1/runs': live('run_gtm_agent', {}, queued) });
  assert.deepEqual(await cmd(agentCommands, 'agents run').run(a), queued);
  assert.equal(a.calls.length, 3);
  const p = fakeCtx(['pb_1'], { yes: true, wait: true }, {
    'POST /api/v2/credits/estimate': runQuote,
    'POST /api/v2/plays/pb_1/runs': live('run_play', {}, { run_id: 'run_1', queued: false, event_id: 'ev_1' }),
    'GET /api/v2/gtm-runs/run_1': { id: 'run_1', status: 'completed' },
    'GET /api/v2/gtm-runs/run_1/records': { records: [], nextCursor: null },
  });
  await cmd(playCommands, 'plays run').run(p);
  assert.equal(p.calls.at(-1).query.include, 'outputs');
});

// tasks
test('tasks list passes status, a normalized type and limit; refuses a bad status before any call', async () => {
  const ctx = fakeCtx([], { status: 'due', type: 'call', limit: '10' }, { 'GET /api/v2/gtm-tasks': { tasks: [] } });
  await cmd(taskCommands, 'tasks list').run(ctx);
  assert.deepEqual(ctx.calls[0].query, { status: 'due', task_type: 'Call', limit: 10 });
  for (const opts of [{ status: 'later' }, { type: 'email' }, { limit: '-1' }]) {
    const c = fakeCtx([], opts, {});
    await assert.rejects(cmd(taskCommands, 'tasks list').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

test('tasks done and skip PATCH the task with done or skipped, without commit unless approved', async () => {
  const routes = { 'PATCH /api/v2/gtm-tasks/t1': (b) => b };
  const done = fakeCtx(['t1'], { outcome: 'Connected', note: 'Booked' }, routes);
  await cmd(taskCommands, 'tasks done').run(done);
  assert.deepEqual(done.calls[0].body, { status: 'done', outcome: 'Connected', note: 'Booked', commit: false });
  const skip = fakeCtx(['t1'], { reason: 'Out of office' }, routes);
  await cmd(taskCommands, 'tasks skip').run(skip);
  assert.deepEqual(skip.calls[0].body, { status: 'skipped', note: 'Out of office', commit: false });
  await assert.rejects(cmd(taskCommands, 'tasks done').run(fakeCtx([], {}, {})), (e) => e.exitCode === EXIT.USAGE);
});

test('tasks done that logs to the CRM: exit 7 with the preview, then --yes commits it', async () => {
  const routes = { 'PATCH /api/v2/gtm-tasks/t1': (b) => (b.commit ? { id: 't1', status: 'done' } : held) };
  const ctx = fakeCtx(['t1'], { outcome: 'Connected' }, routes);
  await assert.rejects(cmd(taskCommands, 'tasks done').run(ctx), (e) => e.exitCode === EXIT.CONFIRM && /HubSpot/.test(e.message));
  assert.equal(ctx.calls.length, 1);
  const yes = fakeCtx(['t1'], { outcome: 'Connected', yes: true }, routes);
  assert.equal((await cmd(taskCommands, 'tasks done').run(yes)).status, 'done');
  assert.equal(yes.calls[0].body.commit, true);
});

test('tasks create needs --lead and a YYYY-MM-DD --due; a reply task cannot be created', async () => {
  const create = cmd(taskCommands, 'tasks create');
  const ctx = fakeCtx([], { lead: 'l1', due: '2026-11-12', type: 'manual' }, { 'POST /api/v2/gtm-tasks': { id: 't1' } });
  await create.run(ctx);
  assert.deepEqual(ctx.calls[0].body, { lead_id: 'l1', task_type: 'Manual', due_at: '2026-11-12', note: undefined, commit: false });
  for (const opts of [{ due: '2026-11-12' }, { lead: 'l1' }, { lead: 'l1', due: 'tomorrow' }, { lead: 'l1', due: '2026-11-12', type: 'Reply' }]) {
    const c = fakeCtx([], opts, {});
    await assert.rejects(create.run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
});

// inbox
const replyPreview = { committed: false, action: 'inbox.reply', preview: { effect: 'send', summary: 'This reply emails jane@acme.com from rep@us.com.', to_email: 'jane@acme.com' } };

test('inbox reply: without --yes and no TTY it exits 7 naming the recipient and never commits', async () => {
  const ctx = fakeCtx(['th1'], { body: 'Tuesday works.' }, { 'POST /api/v2/inbox/threads/th1/reply': (b) => (b.commit ? { sent: true } : replyPreview) });
  await assert.rejects(cmd(inboxCommands, 'inbox reply').run(ctx), (e) => e.exitCode === EXIT.CONFIRM && /jane@acme\.com/.test(e.message));
  assert.deepEqual(ctx.calls.map((c) => c.body.commit), [false]);
});

test('inbox reply: --yes sends the body with commit and a request_id', async () => {
  const ctx = fakeCtx(['th1'], { body: 'Tuesday works.', yes: true }, { 'POST /api/v2/inbox/threads/th1/reply': { sent: true } });
  await cmd(inboxCommands, 'inbox reply').run(ctx);
  const { body } = ctx.calls[0];
  assert.equal(body.commit, true);
  assert.equal(body.body, 'Tuesday works.');
  assert.match(body.request_id, /^[A-Za-z0-9_-]{8,128}$/);
});

test('inbox reply needs exactly one non-empty body; inbox list checks --status and --since', async () => {
  for (const opts of [{}, { body: '  ' }, { body: 'a', 'body-file': 'x.txt' }]) {
    const c = fakeCtx(['th1'], { yes: true, ...opts }, {});
    await assert.rejects(cmd(inboxCommands, 'inbox reply').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
  for (const opts of [{ status: 'unread' }, { since: '11/09/2026' }]) {
    const c = fakeCtx([], opts, {});
    await assert.rejects(cmd(inboxCommands, 'inbox list').run(c), (e) => e.exitCode === EXIT.USAGE);
    assert.equal(c.calls.length, 0);
  }
  const ok = fakeCtx([], { status: 'needs_reply', since: '2026-11-09' }, { 'GET /api/v2/inbox/threads': { threads: [] } });
  await cmd(inboxCommands, 'inbox list').run(ok);
  assert.deepEqual(ok.calls[0].query, { status: 'needs_reply', since: '2026-11-09', q: undefined, limit: undefined, offset: undefined });
});

test('inbox done archives the thread; updates passes --since', async () => {
  const done = fakeCtx(['th1'], {}, { 'PATCH /api/v2/inbox/threads/th1': { id: 'th1' } });
  await cmd(inboxCommands, 'inbox done').run(done);
  assert.deepEqual(done.calls[0].body, { status: 'done', commit: false });
  const up = fakeCtx([], { since: '2026-11-10T09:00:00Z' }, { 'GET /api/v2/updates': { since: 'a', until: 'b' } });
  assert.equal((await cmd(updateCommands, 'updates').run(up)).until, 'b');
  assert.deepEqual(up.calls[0].query, { since: '2026-11-10T09:00:00Z' });
});

// end to end through the binary: exit 7 puts the card on stdout
test('cli: actions run with a card exits 7 and prints the card on stdout', async () => {
  const { code, stdout } = await runCli(['actions', 'run', 'agents.set_status', '--args', '{}', '--json'], {
    handler: (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/v2/actions/agents.set_status') return res.end(JSON.stringify(card));
      res.statusCode = 500;
      res.end('{}');
    },
  });
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(JSON.parse(stdout).card.card_id, 'crd_1');
});

test('cli: the old AI-column flags on agents point at smart-agents; other bad agents flags do not', async () => {
  const run = (args) => runCli(args);
  const old = await run(['agents', 'run', 'Q4', '--column', 'Hook', '--prompt', 'x']);
  assert.equal(old.code, EXIT.USAGE);
  assert.match(old.stderr, /smart-agents/);
  const typo = await run(['agents', 'create', '--nmae', 'x']);
  assert.equal(typo.code, EXIT.USAGE);
  assert.doesNotMatch(typo.stderr, /smart-agents/);
});

test('cli: agents run and plays run with a 0-credit quote and no --yes exit 7 and start nothing', async () => {
  const commits = [];
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v2/credits/estimate') return res.end(JSON.stringify({ ...runQuote, estimated_cost: 0 }));
      const body = JSON.parse(raw || '{}');
      if (body.commit) {
        commits.push(req.url);
        return res.end(JSON.stringify({ run_id: null }));
      }
      res.end(JSON.stringify(preview('run_play', { tool: 'run_play', playbook_id: 'pb_1' })));
    });
  };
  const run = async (args) => (await runCli(args, { handler })).code;
  assert.equal(await run(['agents', 'run', 'f226cde7-1c0a-46e4-a164-642eaffe88ff', '--format', 'table']), EXIT.CONFIRM);
  assert.equal(await run(['plays', 'run', 'pb_1']), EXIT.CONFIRM);
  assert.deepEqual(commits, []);
  assert.equal(await run(['agents', 'run', 'f226cde7-1c0a-46e4-a164-642eaffe88ff', '--yes']), 0);
  assert.equal(commits.length, 1);
});
