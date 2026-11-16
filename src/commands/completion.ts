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
  // Flags whose next word is their value, so it isn't read as a command word. Boolean anywhere wins:
  // ponytail: one table for every command; per-command tables if a name is ever string in one and boolean in another.
  const specs = [global, ...commands.map((c) => c.options ?? {})].flatMap((o) => Object.entries(o));
  const bool = new Set(specs.filter(([, s]) => s.type !== 'string').map(([f]) => f));
  const valueFlags = [...new Set(specs.filter(([f, s]) => s.type === 'string' && !bool.has(f)).flatMap(([f, s]) => [`--${f}`, ...(s.short ? [`-${s.short}`] : [])]))];
  return `# cleanlist completion for bash. Add to ~/.bashrc:  eval "$(cleanlist completion bash)"
_cleanlist() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" w1="" w2="" n=0 i words="" flags=""
  # Command words are the positionals before the cursor: skip flags (global ones may come first) and their values.
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      ${valueFlags.length ? `${valueFlags.join('|')}) [ "\${COMP_WORDS[i+1]}" = "=" ] && i=$((i + 1)); i=$((i + 1)) ;;
      ` : ''}-*|=) ;;
      *) n=$((n + 1)); [ "$n" -eq 1 ] && w1="\${COMP_WORDS[i]}"; [ "$n" -eq 2 ] && w2="\${COMP_WORDS[i]}" ;;
    esac
  done
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
  elif [ "$n" -eq 0 ]; then
    words="${top.join(' ')} help"
  elif [ "$n" -eq 1 ]; then
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
