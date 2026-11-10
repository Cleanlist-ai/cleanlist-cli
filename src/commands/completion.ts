import type { Command, OptSpec } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const SHELLS = ['bash', 'zsh', 'fish'];

/** Top-level words, and the second word for each group (`lists` → rows, get, ...). */
function tree(commands: Command[]) {
  const top = new Set<string>();
  const subs = new Map<string, Set<string>>();
  for (const c of commands) {
    const [a, b] = c.name.split(' ');
    top.add(a);
    if (b) subs.set(a, (subs.get(a) ?? new Set()).add(b));
  }
  return { top: [...top], subs };
}

const flagsOf = (c: Command, global: Record<string, OptSpec>) => Object.keys({ ...global, ...c.options }).map((f) => `--${f}`);

function bash(commands: Command[], global: Record<string, OptSpec>): string {
  const { top, subs } = tree(commands);
  const subCases = [...subs].map(([g, s]) => `    ${g}) words="${[...s].join(' ')}" ;;`).join('\n');
  const flagCases = commands.map((c) => `    "${c.name}") flags="${flagsOf(c, global).join(' ')}" ;;`).join('\n');
  return `# cleanlist completion for bash. Add to ~/.bashrc:  eval "$(cleanlist completion bash)"
_cleanlist() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" w1="\${COMP_WORDS[1]}" w2="\${COMP_WORDS[2]}" words="" flags=""
  case "$w1 $w2" in
${flagCases}
  esac
  if [ -z "$flags" ]; then
    case "$w1" in
${flagCases}
    esac
  fi
  if [[ "$cur" == -* ]]; then
    words="\${flags:-${Object.keys(global).map((f) => `--${f}`).join(' ')}}"
  elif [ "$COMP_CWORD" -eq 1 ]; then
    words="${top.join(' ')} help"
  elif [ "$COMP_CWORD" -eq 2 ]; then
    case "$w1" in
${subCases}
    esac
  fi
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -o default -F _cleanlist cleanlist
`;
}

function zsh(commands: Command[], global: Record<string, OptSpec>): string {
  return `#compdef cleanlist
# cleanlist completion for zsh. Add to ~/.zshrc:  eval "$(cleanlist completion zsh)"
autoload -U +X bashcompinit && bashcompinit
${bash(commands, global).split('\n').slice(1).join('\n')}`;
}

function fish(commands: Command[], global: Record<string, OptSpec>): string {
  const { top, subs } = tree(commands);
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = ['# cleanlist completion for fish. Save as ~/.config/fish/completions/cleanlist.fish:', '#   cleanlist completion fish > ~/.config/fish/completions/cleanlist.fish', 'complete -c cleanlist -f'];
  for (const t of [...top, 'help']) {
    const own = commands.find((c) => c.name === t);
    lines.push(`complete -c cleanlist -n '__fish_use_subcommand' -a ${t}${own ? ` -d ${q(own.summary.slice(0, 80))}` : ''}`);
  }
  for (const [g, s] of subs) {
    for (const sub of s) {
      const c = commands.find((x) => x.name === `${g} ${sub}`)!;
      lines.push(`complete -c cleanlist -n '__fish_seen_subcommand_from ${g}' -a ${sub} -d ${q(c.summary.slice(0, 80))}`);
    }
  }
  for (const [f, s] of Object.entries(global)) lines.push(`complete -c cleanlist -l ${f}${s.short ? ` -s ${s.short}` : ''}${s.type === 'string' ? ' -r' : ''} -d ${q(s.desc.slice(0, 80))}`);
  for (const c of commands) {
    const [a, b] = c.name.split(' ');
    const cond = b ? `__fish_seen_subcommand_from ${a}; and __fish_seen_subcommand_from ${b}` : `__fish_seen_subcommand_from ${a}`;
    for (const [f, s] of Object.entries(c.options ?? {})) lines.push(`complete -c cleanlist -n ${q(cond)} -l ${f}${s.type === 'string' ? ' -r' : ''} -d ${q(s.desc.slice(0, 80))}`);
  }
  return lines.join('\n') + '\n';
}

export function completionScript(shell: string, commands: Command[], global: Record<string, OptSpec>): string {
  if (shell === 'bash') return bash(commands, global);
  if (shell === 'zsh') return zsh(commands, global);
  if (shell === 'fish') return fish(commands, global);
  throw new CliError(EXIT.USAGE, `Pick a shell: ${SHELLS.join(', ')}.`);
}

export function completionCommand(commands: () => Command[], global: Record<string, OptSpec>): Command {
  return {
    name: 'completion',
    args: '<bash|zsh|fish>',
    summary: 'Print a shell completion script.',
    noAuth: true,
    examples: ['eval "$(cleanlist completion zsh)"     # in ~/.zshrc', 'cleanlist completion fish > ~/.config/fish/completions/cleanlist.fish'],
    async run(ctx) {
      process.stdout.write(completionScript(ctx.args[0], commands(), global));
      return undefined;
    },
  };
}
