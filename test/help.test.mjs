import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completionCommand } from '../dist/commands/completion.js';
import { EXIT } from '../dist/errors.js';

const commands = [];
for (const f of readdirSync('dist/commands').filter((f) => f.endsWith('.js'))) {
  for (const v of Object.values(await import(`../dist/commands/${f}`))) if (Array.isArray(v)) commands.push(...v.filter((c) => c?.name && c.run));
}
commands.push(completionCommand(() => commands, {}));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, CLEANLIST_API_KEY: 'test', CI: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('help: every command has a one-line summary and an example that uses only its own and global flags', async () => {
  const global = [...(await run(['whoami', '--help'])).stdout.split('Global flags:')[1].matchAll(/--([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(global.includes('yes') && global.includes('format'));
  assert.ok(commands.length >= 80, `found ${commands.length} commands`);
  for (const c of commands) {
    assert.ok(c.summary && !c.summary.includes('\n'), `${c.name}: summary`);
    const own = (c.examples ?? []).filter((ex) => ex.includes(`cleanlist ${c.name}`));
    assert.ok(own.length, `${c.name}: no example of it`);
    for (const ex of own) {
      const line = ex.slice(ex.indexOf(`cleanlist ${c.name}`)).split(/[|>]|\$\(/)[0];
      for (const [, flag] of line.matchAll(/(?:^|\s)--([a-z-]+)/g)) {
        assert.ok(flag in (c.options ?? {}) || global.includes(flag), `${c.name}: example uses unknown flag --${flag}`);
      }
    }
  }
});

test('help: the README names every command', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const c of commands) assert.ok(readme.includes(`\`${c.name}\``), `README is missing \`${c.name}\``);
});

test('help: --help on a command prints its examples and exits 0', async () => {
  const { code, stdout } = await run(['agents', 'runs', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Examples:\n {2}cleanlist agents runs <agent_id>/);
});

test('errors: an unknown subcommand exits 2 with an error and a fix, not just the group help', async () => {
  const { code, stdout, stderr } = await run(['agents', 'bogus']);
  assert.equal(code, EXIT.USAGE);
  assert.equal(stdout, '');
  const { error } = JSON.parse(stderr);
  assert.match(error.message, /Unknown command "agents bogus"/);
  assert.match(error.fix, /cleanlist agents --help/);
  assert.match(JSON.parse((await run(['agents', 'results', 'x'])).stderr).error.fix, /smart-agents/);
  const bare = await run(['agents']);
  assert.equal(bare.code, EXIT.USAGE);
  assert.match(bare.stdout, /agents runs/);
});

test('errors: a bad-input error with no fix of its own points at the command help', async () => {
  const { code, stderr } = await run(['agents', 'create']);
  assert.equal(code, EXIT.USAGE);
  const { error } = JSON.parse(stderr);
  assert.equal(error.message, 'Pass --name.');
  assert.equal(error.fix, 'Run `cleanlist agents create --help`.');
  assert.equal(error.exit_code, EXIT.USAGE);
});
