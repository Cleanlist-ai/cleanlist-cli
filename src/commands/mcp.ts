import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * Claude Code's user-scope config, where `claude mcp add --scope user` writes:
 * `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
 */
export function claudeCodeConfigPath(home = homedir(), env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
}

/**
 * `{"mcpServers": {"cleanlist": entry}}` merged into a JSON config: an
 * existing cleanlist entry is replaced where it is, every other key and server
 * is left as it was. Returns the new text and the entry it replaced.
 */
export function mergeJsonConfig(existing: string | undefined, entry: Record<string, unknown>, path: string): { next: string; previous: unknown } {
  let cfg: any = {};
  if (existing?.trim()) {
    try {
      cfg = JSON.parse(existing);
    } catch (e) {
      throw new CliError(EXIT.USAGE, `${path} is not valid JSON: ${(e as Error).message}`, 'Fix or move that file, then run this again.');
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new CliError(EXIT.USAGE, `${path} is not a JSON object.`);
  }
  const previous = cfg.mcpServers?.cleanlist;
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), cleanlist: entry };
  return { next: JSON.stringify(cfg, null, 2) + '\n', previous };
}

const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string has JSON's escapes

/**
 * Replace the `[mcp_servers.cleanlist]` table (and its sub-tables) in a Codex
 * config.toml where it stands, keeping everything else; append it when there is none.
 */
export function mergeCodexConfig(existing: string | undefined, block: string): string {
  const lines = (existing ?? '').split('\n');
  const out: string[] = [];
  let skipping = false;
  let at = -1;
  for (const line of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = header[1] === 'mcp_servers.cleanlist' || header[1].startsWith('mcp_servers.cleanlist.');
    if (skipping && at < 0) at = out.length;
    if (!skipping) out.push(line);
  }
  if (at >= 0) {
    const tail = out.slice(at).join('\n').replace(/^\n+/, '');
    const head = out.slice(0, at).join('\n').replace(/\n+$/, '');
    return (head ? head + '\n\n' : '') + block + (tail ? '\n' + tail : '');
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

/** Write next to the file and rename over it, so a failed write never leaves a half-written config. */
function writeConfig(path: string, content: string, key?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = `${target}.cleanlist-${process.pid}.tmp`;
  // A key may be in it: keep the file private to this user.
  writeFileSync(tmp, content, { mode: key ? 0o600 : existsSync(target) ? statSync(target).mode & 0o777 : 0o600 });
  renameSync(tmp, target);
}

const AFTER: Record<Host, (key?: string) => string> = {
  'claude-code': (key) => (key ? 'Start a new Claude Code session to use it.' : 'In Claude Code, run /mcp and sign in to Cleanlist.'),
  cursor: () => 'Restart Cursor (or reload MCP servers) and sign in to Cleanlist when it asks.',
  'claude-desktop': () => 'Restart Claude Desktop.',
  codex: (key) => (key ? 'Start a new Codex session.' : 'Run `codex mcp login cleanlist` to sign in.'),
};

function configPath(host: Host): string {
  if (host === 'claude-code') return claudeCodeConfigPath();
  if (host === 'codex') return join(homedir(), '.codex', 'config.toml');
  return host === 'cursor' ? join(homedir(), '.cursor', 'mcp.json') : desktopConfigPath();
}

function jsonEntry(host: Exclude<Host, 'codex'>, key: string | undefined): Record<string, unknown> {
  const stdio = { command: STDIO.command, args: STDIO.args, env: { CLEANLIST_API_KEY: key } };
  if (host === 'claude-code') return key ? { type: 'stdio', ...stdio } : { type: 'http', url: MCP_URL };
  if (key) return stdio;
  // Claude Desktop's config file only runs local servers; mcp-remote bridges the hosted one and its sign-in.
  return host === 'cursor' ? { url: MCP_URL } : { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL] };
}

/**
 * Write the server into the app's config file, show the diff, and write it
 * once confirmed. An existing Cleanlist entry is updated in place, so there is
 * never a moment without one, and a failed write leaves the old one as it was.
 */
async function install(ctx: Ctx, host: Host, key: string | undefined): Promise<{ path: string; changed: boolean }> {
  const path = configPath(host);
  const exists = existsSync(path);
  if (host === 'claude-code' && !exists) {
    throw new CliError(EXIT.ERROR, `Claude Code's config (${path}) isn't here.`, 'Install Claude Code and start it once, then run this again.');
  }
  const before = exists ? readFileSync(path, 'utf8') : '';
  let next: string;
  let diff: string;
  if (host === 'codex') {
    next = mergeCodexConfig(before, codexBlock(key));
    if (before === next) return unchanged(ctx, path);
    diff = lineDiff(before, next);
  } else {
    const entry = jsonEntry(host, key);
    const merged = mergeJsonConfig(before, entry, path);
    if (JSON.stringify(merged.previous) === JSON.stringify(entry)) return unchanged(ctx, path);
    next = merged.next;
    // ~/.claude.json holds all of Claude Code's state: show only the entry.
    const show = (v: unknown) => (v === undefined ? '' : JSON.stringify({ cleanlist: v }, null, 2) + '\n');
    diff = host === 'claude-code' ? lineDiff(show(merged.previous), show(entry)) : lineDiff(before, next);
  }
  ctx.log(`${exists ? 'Changes to' : 'New file'} ${path}:\n${mask(diff)}`);
  await confirmAction(ctx, `Write ${path}?`);
  writeConfig(path, next, key);
  ctx.log(`Wrote ${path}. ${AFTER[host](key)}`);
  return { path, changed: true };
}

function unchanged(ctx: Ctx, path: string) {
  ctx.log(`${path} already has this Cleanlist server.`);
  return { path, changed: false };
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
      const { path, changed } = await install(ctx, host, key);
      return { host, mode: key ? 'api_key' : 'oauth', path, installed: true, changed };
    },
  },
];
