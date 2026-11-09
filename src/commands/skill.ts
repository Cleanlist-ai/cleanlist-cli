import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from '../context.js';
import { CliError, EXIT } from '../errors.js';

/** What a coding agent needs to drive the CLI well. Kept short: it is loaded into context. */
export const SKILL_BODY = `# Cleanlist CLI

Cleanlist finds B2B people and companies and enriches them with verified work
emails, phones and firmographics. Use the \`cleanlist\` CLI (\`npx @cleanlist-ai/cli\`)
from the shell. Check auth first: \`cleanlist whoami\` (exit 3 = not signed in:
ask the user to run \`cleanlist login\` or set CLEANLIST_API_KEY).

## Workflows
- Enrich a CSV: \`cleanlist enrich csv leads.csv --dry-run\` (shows cost), then after
  the user approves: \`cleanlist enrich csv leads.csv --yes -o leads.enriched.csv\`
- Find people at companies: \`cleanlist people search --company-domains-file domains.txt --title "VP Sales" --json\`
  then save: \`cleanlist lists add "<list>" --from-task <task_id>\`
- Export a list: \`cleanlist lists export "<list>" -o out.csv\`
- Read a list: \`cleanlist lists rows "<list>" --all --format jsonl\`
- AI column: \`cleanlist agents run "<list>" --column Hook --prompt "..." --rows 10 --dry-run\`
- Credits: \`cleanlist credits --json\`

## Rules
- Paid commands print a quote. Exit 7 means confirmation is required: show the
  user the cost from the quote, and only re-run with \`--yes\` after they approve
  it. A quote is not approval. Use \`--max-credits N\` as a ceiling.
- Keep rows out of the conversation: write files with \`-o\`/\`--format csv\` and
  summarize, instead of printing hundreds of rows.
- Output is JSON when piped; errors are JSON on stderr with a \`fix\` hint.
- Exit codes: 0 ok, 2 bad input, 3 auth/plan, 4 not found, 5 credits,
  6 rate limited, 7 needs --yes, 8 still running (the error prints a resume command).
- People search has a daily cap per API key: don't loop \`--all\`.
- Lists can be named by id or exact name.
- \`cleanlist <command> --help\` lists every flag.
`;

const TARGETS: Record<string, { path: string; wrap: (body: string) => string; append?: boolean }> = {
  claude: {
    path: '.claude/skills/cleanlist/SKILL.md',
    wrap: (b) => `---\nname: cleanlist\ndescription: Find B2B people and companies, enrich CSVs and lead lists with emails and phones, run AI columns, and export with the Cleanlist CLI.\n---\n\n${b}`,
  },
  cursor: {
    path: '.cursor/rules/cleanlist.mdc',
    wrap: (b) => `---\ndescription: Cleanlist CLI for B2B lead search, enrichment and export\nalwaysApply: false\n---\n\n${b}`,
  },
  agents: { path: 'AGENTS.md', wrap: (b) => `\n<!-- cleanlist-cli -->\n${b}<!-- /cleanlist-cli -->\n`, append: true },
};

export const skillCommands: Command[] = [
  {
    name: 'skill',
    summary: 'Print agent instructions for this CLI, or install them for Claude Code, Cursor or Codex (AGENTS.md).',
    noAuth: true,
    options: { target: { type: 'string', desc: 'claude | cursor | agents: write the file into the current project.' } },
    examples: ['cleanlist skill --target claude', 'cleanlist skill --target agents', 'cleanlist skill > CLEANLIST.md'],
    async run(ctx) {
      const t = ctx.opts.target;
      if (!t) {
        process.stdout.write(SKILL_BODY);
        return undefined;
      }
      const target = TARGETS[t];
      if (!target) throw new CliError(EXIT.USAGE, `--target must be one of ${Object.keys(TARGETS).join(', ')}.`);
      if (target.append && existsSync(target.path) && readFileSync(target.path, 'utf8').includes('<!-- cleanlist-cli -->')) {
        ctx.log(`${target.path} already has the Cleanlist section.`);
        return { path: target.path, written: false };
      }
      mkdirSync(dirname(target.path), { recursive: true });
      (target.append ? appendFileSync : writeFileSync)(target.path, target.wrap(SKILL_BODY));
      ctx.log(`Wrote ${target.path}.`);
      return { path: target.path, written: true };
    },
  },
];
