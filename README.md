# Cleanlist CLI

Find B2B people, enrich CSVs and lead lists with verified work emails and phones,
run AI columns, manage GTM agents, and export, from your terminal. Built for developers working in
Claude Code, Cursor and Codex: output is JSON when piped, nothing prompts without
a terminal, and every paid action shows a quote first.

```bash
npx @cleanlist-ai/cli login
npx @cleanlist-ai/cli enrich csv leads.csv --dry-run
```

Or install it: `npm i -g @cleanlist-ai/cli`, then use `cleanlist`.

Needs Node 18.18+ and a Cleanlist plan with API access.

## Sign in

```bash
cleanlist login                     # browser sign-in; pick the workspace on the consent screen
cleanlist login --device            # SSH / no browser: confirm a code on another device
cleanlist login --api-key clapi_…   # or store an API key (Settings → API keys)
export CLEANLIST_API_KEY=clapi_…    # CI and scripts: nothing is stored
```

One profile is one workspace. Add more with `cleanlist login --profile acme` and pick
one with `--profile acme` or `CLEANLIST_PROFILE=acme`. `cleanlist whoami` always shows
which workspace you are acting in. Credentials live in the OS keychain (macOS Keychain,
libsecret), or in `~/.config/cleanlist/credentials.json` (mode 0600) when there is none.

## What you can do

```bash
# Enrich a CSV and write the result
cleanlist enrich csv leads.csv --yes -o leads.enriched.csv

# Find people at a set of companies, then save them to a list
cleanlist people search --company-domains-file domains.txt --title "VP Sales" --json \
  | jq -r .task_id | xargs -I{} cleanlist lists add "Q4 ABM" --from-task {}

# Export a list
cleanlist lists export "Q4 ABM" -o q4.csv

# Read a list as JSON lines
cleanlist lists rows "Q4 ABM" --all --format jsonl

# Fill an AI column on the first 10 rows
cleanlist smart-agents run "Q4 ABM" --column Hook --prompt "One-line opener about {{company}}" --rows 10 --yes --wait

# GTM agents: list them, read a run's records, turn one off
cleanlist agents list
cleanlist agents runs <agent_id>
cleanlist plays results <run_id> --wait
cleanlist agents off <agent_id>

# Anything Clu can do: list the actions, run one
cleanlist actions list
cleanlist actions run agents.get --args '{"agent_id":"..."}' --json

# Get events at your own URL (the signing secret is shown once)
cleanlist webhooks add https://example.com/hooks/cleanlist --events play_run.completed,reply.received

# Credits and usage
cleanlist credits
cleanlist usage --group-by tool
```

Run `cleanlist --help` for every command and `cleanlist <command> --help` for flags
and examples. Lists can be named by id or exact name.

| Group | Commands |
|---|---|
| Account | `login`, `logout`, `whoami`, `profiles`, `credits`, `credits estimate`, `usage` |
| People | `people search`, `people filters`, `people compile` |
| Enrich | `enrich person`, `enrich company`, `enrich list`, `enrich task`, `enrich csv`, `enrich status` |
| Lists | `lists`, `lists get`, `lists create`, `lists rename`, `lists delete`, `lists rows`, `lists add`, `lists remove`, `lists import`, `lists export` |
| Smart agents (AI columns) | `smart-agents run`, `smart-agents list`, `smart-agents results` |
| GTM agents | `agents list`, `agents get`, `agents create`, `agents update`, `agents off`, `agents runs`, `plays results` |
| Actions (Clu tools) | `actions list`, `actions run`, `actions confirm` |
| Webhooks | `webhooks list`, `webhooks add`, `webhooks remove` |
| Agent setup | `skill`, `mcp install` |

Turning an agent on, running it now and changing its limits are a person's to
do in the Cleanlist app. The API refuses them from code (exit 3,
`person_required`), so the CLI has no command for them.

## Paying for things

Commands that spend credits (`enrich *`, `smart-agents run`) first ask the API for a
signed quote and show it:

- in a terminal, you're asked `Spend 1,240 credits? [y/N]`;
- with `--yes`, it goes ahead;
- without a terminal and without `--yes`, it exits **7** and prints the quote, so a
  coding agent can show you the cost before re-running with `--yes`;
- `--dry-run` prints the quote and stops; `--max-credits N` refuses anything above N
  (exit 5).

Credits are charged exactly as through the API.

`actions run` works the same way with a card instead of a quote: an action that
spends, sends, deletes or writes to a CRM returns a card and runs nothing. `--yes`
(or a yes at the prompt) confirms it; otherwise it exits 7 with the card, and
`cleanlist actions confirm <card_id> --session <session_id>` runs it after the user
approves. Deletes, sends and CRM writes also need the key's opt-in scope
(`lists:delete`, `sequences:write`, `crm:write`), ticked per key in Settings → API
keys; without it they exit 3 with `opt_in_scope_required` and the scope's name.

## Output and exit codes

Tables in a terminal, JSON when piped (`--json`, `--format jsonl|csv` to choose).
Data goes to stdout, progress to stderr (`-q` silences it). Errors are JSON on stderr
when piped, with a `fix` hint.

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Unexpected or server error |
| 2 | Bad input (flags, validation, ambiguous list name) |
| 3 | Not signed in, revoked, the plan has no API access, or a person must do it (`person_required`, `opt_in_scope_required`) |
| 4 | Not found |
| 5 | Not enough credits, or the quote is above `--max-credits` |
| 6 | Rate limited |
| 7 | Confirmation required: re-run with `--yes` once the cost is approved |
| 8 | `--wait` timed out; the job is still running (the error shows how to resume) |

`--wait` polls with backoff; `--timeout 10m` caps it.

Retries: only a GET is retried, up to 3 tries, on 502, 503 or 504 (or no response),
honoring `Retry-After`. A POST, PATCH or DELETE is sent once and never resent, so a
write can't run twice; when one gets no response, check before running it again.

## Coding agents

```bash
cleanlist skill --target claude   # .claude/skills/cleanlist/SKILL.md
cleanlist skill --target cursor   # .cursor/rules/cleanlist.mdc
cleanlist skill --target agents   # appends a section to AGENTS.md (Codex and others)
```

The skill tells the agent how to check auth, the main workflows, and the rules:
show the human every quote before `--yes`, keep rows in files rather than the
conversation, and branch on exit codes.

The CLI and the [Cleanlist MCP server](https://docs.cleanlist.ai/mcp) work well
together: use the MCP to explore in chat, and the CLI to move data in bulk.

```bash
cleanlist mcp install claude-code             # hosted server, sign in from the app
cleanlist mcp install cursor --api-key -      # local server with a key (hidden prompt)
cleanlist mcp install claude-desktop
cleanlist mcp install codex
```

`mcp install` shows the change to the app's config file and writes it once you
confirm (`--yes` without a terminal). Running it again updates the existing
Cleanlist entry in place and leaves every other server and setting as it was.

## Environment

| Variable | Use |
|---|---|
| `CLEANLIST_API_KEY` | API key; overrides any saved login |
| `CLEANLIST_PROFILE` | Profile to use |
| `CLEANLIST_HOST` | API base URL (default `https://api.cleanlist.ai`) |
| `CLEANLIST_CONFIG_DIR` | Config directory (default `~/.config/cleanlist`) |
| `CLEANLIST_NO_KEYCHAIN` | Store credentials in the file, not the keychain |
| `CLEANLIST_OAUTH_ISSUER`, `CLEANLIST_OAUTH_CLIENT_ID` | Sign-in server and client, for staging |

## Development

```bash
npm install
npm test             # build + unit tests
npm run check-spec   # every API path the CLI calls is in the public v2 spec
node dist/cli.js --help
```

Commits follow Conventional Commits; merging to `main` releases to npm
(`feat:` → minor, `fix:` → patch, `!` → major).

## License

MIT
