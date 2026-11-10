#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Api } from './api.js';
import { type Credential, DEFAULT_API_URL, loadConfig, loadCredential, profileName } from './config.js';
import { type Command, type Ctx, DryRun, logTo, type OptSpec } from './context.js';
import { CliError, EXIT } from './errors.js';
import { type Format, print } from './output.js';
import { VERSION } from './version.js';
import { accountCommands } from './commands/account.js';
import { actionCommands } from './commands/actions.js';
import { agentCommands } from './commands/agents.js';
import { dataCommands } from './commands/data.js';
import { enrichCommands } from './commands/enrich.js';
import { listCommands } from './commands/lists.js';
import { peopleCommands } from './commands/people.js';
import { playCommands } from './commands/plays.js';
import { sequenceCommands } from './commands/sequences.js';
import { skillCommands } from './commands/skill.js';
import { smartAgentCommands } from './commands/smart-agents.js';
import { webhookCommands } from './commands/webhooks.js';

const COMMANDS: Command[] = [
  ...accountCommands,
  ...peopleCommands,
  ...enrichCommands,
  ...listCommands,
  ...smartAgentCommands,
  ...dataCommands,
  ...agentCommands,
  ...playCommands,
  ...sequenceCommands,
  ...webhookCommands,
  ...actionCommands,
  ...skillCommands,
];

const GLOBAL: Record<string, OptSpec> = {
  json: { type: 'boolean', desc: 'Same as --format json.' },
  format: { type: 'string', desc: 'table | json | jsonl | csv. Default: table in a terminal, json when piped.' },
  yes: { type: 'boolean', short: 'y', desc: 'Approve the quoted cost or deletion without asking.' },
  'dry-run': { type: 'boolean', desc: 'Paid commands: print the quote and stop.' },
  'max-credits': { type: 'string', desc: 'Paid commands: refuse (exit 5) if the quote is above this.' },
  profile: { type: 'string', desc: 'Saved profile (workspace) to use. Env: CLEANLIST_PROFILE.' },
  'api-key': { type: 'string', desc: 'Use this API key. Env: CLEANLIST_API_KEY.' },
  'api-url': { type: 'string', desc: 'API base URL. Env: CLEANLIST_HOST.' },
  'no-input': { type: 'boolean', desc: 'Never prompt (also when not a TTY or CI is set).' },
  quiet: { type: 'boolean', short: 'q', desc: 'No progress messages on stderr.' },
  help: { type: 'boolean', short: 'h', desc: 'Show help.' },
  version: { type: 'boolean', short: 'v', desc: 'Show the version.' },
};

const GROUPS: [string, string][] = [
  ['Account', 'login logout whoami profiles credits usage'],
  ['People', 'people'],
  ['Enrich', 'enrich'],
  ['Lists', 'lists'],
  ['AI columns', 'smart-agents'],
  ['Signals and account data', 'jobs job-changes linkedin companies meetings'],
  ['GTM agents and plays', 'agents plays'],
  ['Sequences', 'sequences'],
  ['Webhooks', 'webhooks'],
  ['Actions (every Clu tool)', 'actions'],
  ['Agent setup', 'skill'],
];

function toParseOptions(specs: Record<string, OptSpec>): any {
  return Object.fromEntries(
    Object.entries(specs).map(([k, s]) => [k, { type: s.type, ...(s.short ? { short: s.short } : {}), ...(s.multiple ? { multiple: true } : {}) }]),
  );
}

/** The output format in effect, so errors thrown anywhere are written the same way. */
let currentFormat: Format = process.stdout.isTTY ? 'table' : 'json';

/** Longest command name matching the leading positionals. */
function findCommand(positionals: string[]): { cmd?: Command; rest: string[] } {
  for (const n of [2, 1]) {
    const name = positionals.slice(0, n).join(' ');
    const cmd = COMMANDS.find((c) => c.name === name);
    if (cmd) return { cmd, rest: positionals.slice(n) };
  }
  return { rest: positionals };
}

function flagLines(specs: Record<string, OptSpec>): string {
  return Object.entries(specs)
    .map(([k, s]) => {
      const flag = `${s.short ? `-${s.short}, ` : '    '}--${k}${s.type === 'string' ? ' <value>' : ''}`;
      return `  ${flag.padEnd(34)} ${s.desc}`;
    })
    .join('\n');
}

function commandHelp(cmd: Command): string {
  const subs = COMMANDS.filter((c) => c.name.startsWith(cmd.name + ' '));
  return [
    `Usage: cleanlist ${cmd.name}${cmd.args ? ' ' + cmd.args : ''} [flags]`,
    '',
    cmd.summary,
    cmd.options ? `\nFlags:\n${flagLines(cmd.options)}` : '',
    subs.length ? `\nSubcommands:\n${subs.map((s) => `  ${s.name.padEnd(22)} ${s.summary}`).join('\n')}` : '',
    cmd.examples ? `\nExamples:\n${cmd.examples.map((e) => `  ${e}`).join('\n')}` : '',
    `\nGlobal flags:\n${flagLines(GLOBAL)}`,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n';
}

function groupHelp(prefix: string): string {
  const subs = COMMANDS.filter((c) => c.name.startsWith(prefix + ' '));
  return `Usage: cleanlist ${prefix} <command> [flags]\n\nCommands:\n${subs.map((s) => `  ${s.name.padEnd(22)} ${s.summary}`).join('\n')}\n\nRun \`cleanlist ${prefix} <command> --help\` for flags.\n`;
}

function mainHelp(): string {
  const groups = GROUPS.map(([title, names]) => {
    const cmds = COMMANDS.filter((c) => names.split(' ').some((n) => c.name === n || c.name.startsWith(n + ' ')));
    return `${title}:\n${cmds.map((c) => `  ${c.name.padEnd(22)} ${c.summary}`).join('\n')}`;
  });
  return `Cleanlist CLI ${VERSION}: find people, enrich CSVs and lists, run agents and plays, export.

Usage: cleanlist <command> [flags]

${groups.join('\n\n')}

Auth: \`cleanlist login\`, or set CLEANLIST_API_KEY. Paid commands show a quote and need
--yes (or a yes at the prompt). Output is a table in a terminal and JSON when piped.

Exit codes: 0 ok, 1 error, 2 bad input, 3 auth/plan, 4 not found, 5 credits,
6 rate limited, 7 confirmation required, 8 still running after --wait timeout.

Run \`cleanlist <command> --help\` for flags and examples. Agents: \`cleanlist skill\`.
`;
}

function fail(e: CliError, format: Format): never {
  if (format === 'table' && process.stderr.isTTY) {
    process.stderr.write(`Error: ${e.message}\n${e.fix ? `Fix: ${e.fix}\n` : ''}`);
  } else {
    const env = (e.detail?.error as Record<string, unknown> | undefined) ?? {};
    const { error: _e, ...rest } = e.detail ?? {};
    process.stderr.write(JSON.stringify({ error: { ...env, message: e.message, fix: e.fix ?? env.fix, exit_code: e.exitCode, ...rest } }) + '\n');
  }
  // Exit 7 also puts the quote (or action card) on stdout, so a caller reading stdout can show the cost.
  const pending = e.detail?.quote ?? e.detail?.card;
  if (e.exitCode === EXIT.CONFIRM && pending) process.stdout.write(JSON.stringify(pending, null, 2) + '\n');
  process.exit(e.exitCode);
}

async function main(argv: string[]): Promise<void> {
  // Pass 1: find the command, tolerating any flag.
  const loose = parseArgs({ args: argv, options: toParseOptions(GLOBAL), strict: false, allowPositionals: true });
  const { cmd, rest } = findCommand(loose.positionals);
  const g = loose.values as Record<string, unknown>;
  let format: Format = g.json ? 'json' : ((g.format as Format) ?? currentFormat);
  currentFormat = format;

  if (g.version && !cmd) return void process.stdout.write(VERSION + '\n');
  if (!cmd) {
    const first = loose.positionals[0];
    if (first === 'help') {
      const target = findCommand(loose.positionals.slice(1)).cmd;
      const prefix = loose.positionals[1];
      return void process.stdout.write(target ? commandHelp(target) : prefix ? groupHelp(prefix) : mainHelp());
    }
    if (first && COMMANDS.some((c) => c.name.startsWith(first + ' '))) {
      process.stdout.write(groupHelp(first));
      if (!g.help) process.exit(EXIT.USAGE);
      return;
    }
    if (first) throw new CliError(EXIT.USAGE, `Unknown command "${first}".`, 'Run `cleanlist --help`.');
    return void process.stdout.write(mainHelp());
  }
  if (g.help) return void process.stdout.write(commandHelp(cmd));

  // Pass 2: strict parse with this command's flags.
  let values: Record<string, any>;
  try {
    values = parseArgs({
      args: argv,
      options: toParseOptions({ ...GLOBAL, ...cmd.options }),
      strict: true,
      allowPositionals: true,
    }).values;
  } catch (e) {
    throw new CliError(EXIT.USAGE, (e as Error).message.replace(/\. To specify.*$/s, '.'), `Run \`cleanlist ${cmd.name} --help\`.`);
  }
  format = values.json ? 'json' : (values.format ?? format);
  if (!['table', 'json', 'jsonl', 'csv'].includes(format)) throw new CliError(EXIT.USAGE, `--format must be table, json, jsonl or csv.`);
  currentFormat = format;

  const profile = profileName(values.profile);
  const saved = loadConfig().profiles[profile];
  const apiUrl = values['api-url'] || process.env.CLEANLIST_HOST || saved?.apiUrl || DEFAULT_API_URL;
  const quiet = Boolean(values.quiet);

  let api: Api | undefined;
  const ctx: Ctx = {
    args: rest,
    opts: values,
    format,
    profile,
    apiUrl,
    quiet,
    log: logTo(quiet),
    get api() {
      if (!api) {
        const key = (cmd.name !== 'login' && values['api-key']) || process.env.CLEANLIST_API_KEY;
        const cred: Credential | undefined = key ? { type: 'api_key', key } : loadCredential(profile);
        api = new Api(apiUrl, cred, profile, !key);
      }
      return api;
    },
  };

  try {
    const data = await cmd.run(ctx);
    print(data, format, cmd.view);
  } catch (e) {
    if (e instanceof DryRun) return print(e.output, format === 'table' ? 'table' : 'json');
    throw e;
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof CliError) fail(e, currentFormat);
  fail(new CliError(EXIT.ERROR, e instanceof Error ? e.message : String(e)), currentFormat);
});
