import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Command, confirmAction, type Ctx, readKey } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export const MCP_URL = 'https://mcp.cleanlist.ai/v1/mcp';
/** The stdio server (`cleanlist-mcp` in @cleanlist-ai/mcp), run through npx so there's nothing to install. */
const STDIO = { command: 'npx', args: ['-y', '--package', '@cleanlist-ai/mcp', 'cleanlist-mcp'] };
const HOSTS = ['claude-code', 'claude-desktop', 'cursor', 'codex'] as const;
type Host = (typeof HOSTS)[number];

export function desktopConfigPath(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** Every API key in `s` cut to its start and end, so a key already in a config doesn't print either. */
const mask = (s: string) => s.replace(/clapi_[^\s"'\\]+/g, (k) => `${k.slice(0, 10)}…${k.slice(-4)}`);

/** `{"mcpServers": {"cleanlist": entry}}` merged into a JSON config, other servers untouched. */
export function mergeJsonConfig(existing: string | undefined, entry: Record<string, unknown>, path: string): string {
  let cfg: any = {};
  if (existing?.trim()) {
    try {
      cfg = JSON.parse(existing);
    } catch (e) {
      throw new CliError(EXIT.USAGE, `${path} is not valid JSON: ${(e as Error).message}`, 'Fix or move that file, then run this again.');
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new CliError(EXIT.USAGE, `${path} is not a JSON object.`);
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), cleanlist: entry };
  return JSON.stringify(cfg, null, 2) + '\n';
}

const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string has JSON's escapes

/** Replace the `[mcp_servers.cleanlist]` table (and its sub-tables) in a Codex config.toml, keeping everything else. */
export function mergeCodexConfig(existing: string | undefined, block: string): string {
  const lines = (existing ?? '').split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = header[1] === 'mcp_servers.cleanlist' || header[1].startsWith('mcp_servers.cleanlist.');
    if (!skipping) out.push(line);
  }
  const kept = out.join('\n').replace(/\n+$/, '');
  return (kept ? kept + '\n\n' : '') + block;
}

export function codexBlock(key?: string): string {
  if (!key) return `[mcp_servers.cleanlist]\nurl = ${tomlString(MCP_URL)}\n`;
  return [
    '[mcp_servers.cleanlist]',
    `command = ${tomlString(STDIO.command)}`,
    `args = [${STDIO.args.map(tomlString).join(', ')}]`,
    `env = { CLEANLIST_API_KEY = ${tomlString(key)} }`,
    '',
  ].join('\n');
}

/** A line diff (LCS), enough to show a config change before it's written. */
export function lineDiff(before: string, after: string): string {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.replace(/\n$/, '').split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push(`  ${a[i++]}`), j++;
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join('\n') + '\n';
}

function writeConfig(path: string, content: string, key?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // A key may be in it: a new file is private to this user, and so is an
  // existing one before the key goes in.
  if (key && existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, content, { mode: 0o600 });
}

async function installClaudeCode(ctx: Ctx, key: string | undefined): Promise<void> {
  // The name goes before -e: -e takes every value up to the next flag,
  // so a name after it is read as another variable.
  const args = key
    ? ['mcp', 'add', '--scope', 'user', 'cleanlist', '-e', `CLEANLIST_API_KEY=${key}`, '--', STDIO.command, ...STDIO.args]
    : ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'cleanlist', MCP_URL];
  ctx.log(`Will run: claude ${mask(args.join(' '))}`);
  await confirmAction(ctx, 'Add Cleanlist to Claude Code?');
  const add = () => execFileSync('claude', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    try {
      add();
    } catch (e) {
      // Replace an earlier install only once the add is known to fail
      // for that reason, so a failing add never leaves the user with none.
      if (!/already exists/i.test((e as { stderr?: Buffer }).stderr?.toString() ?? '')) throw e;
      execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'cleanlist'], { stdio: 'ignore' });
      add();
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
    if (err.code === 'ENOENT') throw new CliError(EXIT.ERROR, 'The `claude` command is not on PATH.', `Install Claude Code, or run: claude ${mask(args.join(' '))}`);
    throw new CliError(EXIT.ERROR, `claude mcp add failed: ${mask(err.stderr?.toString().trim() || err.message)}`);
  }
  ctx.log(key ? 'Added. Start a new Claude Code session to use it.' : 'Added. In Claude Code, run /mcp and sign in to Cleanlist.');
}

/** Merge the server into the app's config file, show the diff, and write it once confirmed. */
async function installConfigFile(ctx: Ctx, host: Exclude<Host, 'claude-code'>, key: string | undefined): Promise<{ path: string; changed: boolean }> {
  const path = host === 'codex' ? join(homedir(), '.codex', 'config.toml') : host === 'cursor' ? join(homedir(), '.cursor', 'mcp.json') : desktopConfigPath();
  const exists = existsSync(path);
  const before = exists ? readFileSync(path, 'utf8') : '';
  let next: string;
  if (host === 'codex') {
    next = mergeCodexConfig(before, codexBlock(key));
  } else {
    // Claude Desktop's config file only runs local servers; mcp-remote bridges the hosted one and its sign-in.
    const oauthEntry = host === 'cursor' ? { url: MCP_URL } : { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL] };
    next = mergeJsonConfig(before, key ? { command: STDIO.command, args: STDIO.args, env: { CLEANLIST_API_KEY: key } } : oauthEntry, path);
  }
  if (before === next) {
    ctx.log(`${path} already has this Cleanlist server.`);
    return { path, changed: false };
  }
  ctx.log(`${exists ? 'Changes to' : 'New file'} ${path}:\n${mask(lineDiff(before, next))}`);
  await confirmAction(ctx, `Write ${path}?`);
  writeConfig(path, next, key);
  const after = {
    cursor: 'Restart Cursor (or reload MCP servers) and sign in to Cleanlist when it asks.',
    'claude-desktop': 'Restart Claude Desktop.',
    codex: key ? 'Start a new Codex session.' : 'Run `codex mcp login cleanlist` to sign in.',
  }[host];
  ctx.log(`Wrote ${path}. ${after}`);
  return { path, changed: true };
}

export const mcpCommands: Command[] = [
  {
    name: 'mcp install',
    args: '<claude-code|claude-desktop|cursor|codex>',
    summary: 'Add the Cleanlist MCP server to an AI app. Hosted with sign-in by default; --api-key runs it locally with a key.',
    noAuth: true,
    options: {
      oauth: { type: 'boolean', desc: 'Use the hosted server and sign in from the app (default).' },
    },
    examples: [
      'cleanlist mcp install claude-code',
      'cleanlist mcp install cursor --yes',
      'cleanlist mcp install claude-desktop --api-key -   # paste the key at a hidden prompt',
      'printenv CLEANLIST_API_KEY | cleanlist mcp install cursor --api-key - --yes',
      'cleanlist mcp install codex',
    ],
    async run(ctx) {
      const host = ctx.args[0] as Host;
      if (!HOSTS.includes(host)) throw new CliError(EXIT.USAGE, `Pick the app: ${HOSTS.join(', ')}.`);
      if (ctx.opts['api-key'] !== undefined && ctx.opts.oauth) throw new CliError(EXIT.USAGE, 'Pass --api-key or --oauth, not both.');
      const key = ctx.opts['api-key'] === undefined ? undefined : await readKey(ctx.opts['api-key']);
      if (key !== undefined && !String(key).startsWith('clapi_')) throw new CliError(EXIT.USAGE, 'That is not a Cleanlist API key (they start with clapi_).');
      const mode = key ? 'api_key' : 'oauth';
      if (host === 'claude-code') {
        await installClaudeCode(ctx, key);
        return { host, mode, installed: true };
      }
      const { path, changed } = await installConfigFile(ctx, host, key);
      return { host, mode, path, installed: true, changed };
    },
  },
];
