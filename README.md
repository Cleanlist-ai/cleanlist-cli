# Cleanlist CLI

Find B2B people, enrich CSVs and lead lists with verified work emails and phones,
run AI columns, run GTM agents and plays, work your tasks and Inbox, and export, from your terminal. Built for developers working in
Claude Code, Cursor and Codex: output is JSON when piped, nothing prompts without
a terminal, and every paid action shows a quote first.

```bash
npx @cleanlist-ai/cli login
npx @cleanlist-ai/cli enrich csv leads.csv --dry-run
```

Or install it: `npm i -g @cleanlist-ai/cli`, then use `cleanlist`.

Needs Node 22.23.4+, 24.22.1+ or 26.12.1+ (the releases with the fix for CVE-2026-111497) and a Cleanlist plan with API access.

## Sign in

```bash
cleanlist login                     # browser sign-in; pick the workspace on the consent screen
cleanlist login --device            # SSH / no browser: confirm a code on another device
cleanlist login --api-key clapi_…   # or store an API key (Settings → API keys)
export CLEANLIST_API_KEY=clapi_…    # CI and scripts: nothing is stored
```

One profile is one workspace. Add more with `cleanlist login --profile acme`, switch
with `cleanlist use acme`, or pick one per command with `--profile acme` or
`CLEANLIST_PROFILE=acme`. `cleanlist whoami` always shows
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

# GTM agents: list them, turn one on, run it now, read a run's records
cleanlist agents list
cleanlist agents on <agent_id> --dry-run
cleanlist agents run <agent_id> --yes --wait
cleanlist agents runs <agent_id>
cleanlist plays results <run_id> --wait

# A play as a function: one record in, its outputs back
cleanlist plays list
cleanlist plays run <playbook_id> --inputs '{"email":"jane@acme.com"}' --yes --wait

# Your day: what's new, tasks due, replies to answer
cleanlist updates
cleanlist tasks list --status due
cleanlist inbox list --status needs_reply
cleanlist inbox reply <thread_id> --body "Tuesday at 2 works."

# Data pulls: job postings, job changes, company signals, meetings
cleanlist jobs search --title "Head of RevOps" --posted-within-days 30 --dry-run
cleanlist job-changes list --since 2026-11-01
cleanlist companies signals --company-domain acme.com --yes
cleanlist meetings list --account acme.com

# Up to 1,000 lookups in one call and one quote
cleanlist batch people leads.csv --fields email,phone --dry-run

# Watch events live and forward them, signed, to your local server
cleanlist listen --forward-to http://localhost:3000/webhooks
cleanlist logs --status 4xx --since 1h

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
| Account | `login`, `logout`, `whoami`, `profiles`, `use`, `credits`, `credits estimate`, `usage` |
| People | `people search`, `people filters`, `people compile` |
| Enrich | `enrich person`, `enrich company`, `enrich list`, `enrich task`, `enrich csv`, `enrich status`, `batch people`, `batch companies` |
| Lists | `lists`, `lists get`, `lists create`, `lists rename`, `lists delete`, `lists rows`, `lists add`, `lists remove`, `lists import`, `lists export` |
| Smart agents (AI columns) | `smart-agents run`, `smart-agents list`, `smart-agents results` |
| Signals and account data | `jobs search`, `job-changes list`, `job-changes check`, `linkedin posts`, `linkedin engagers`, `companies tech`, `companies signals`, `companies committee`, `companies org`, `meetings list`, `meetings read` |
| GTM agents and plays | `agents list`, `agents get`, `agents create`, `agents update`, `agents on`, `agents off`, `agents run`, `agents runs`, `plays list`, `plays run`, `plays event`, `plays results` |
| Sequences, tasks and Inbox | `sequences list`, `sequences get`, `sequences edit`, `sequences status`, `sequences enroll`, `tasks list`, `tasks get`, `tasks done`, `tasks skip`, `tasks create`, `inbox list`, `inbox read`, `inbox reply`, `inbox done`, `updates` |
| Webhooks | `webhooks list`, `webhooks add`, `webhooks remove` |
| Actions (Clu tools) | `actions list`, `actions run`, `actions confirm` |
| Developer | `listen`, `logs`, `completion` |
| Agent setup | `skill`, `mcp install` |

An agent's limits stay a person's to set in the Cleanlist app.

## Paying for things

Commands that spend credits (`enrich *`, `batch *`, `smart-agents run`, the paid
data pulls) first ask the API for a signed quote and show it:

- in a terminal, you're asked `Spend 1,240 credits? [y/N]`;
- with `--yes`, it goes ahead;
- without a terminal and without `--yes`, it exits **7** and prints the quote, so a
  coding agent can show you the cost before re-running with `--yes`;
- `--dry-run` prints the quote and stops; `--max-credits N` refuses anything above N
  (exit 5).

Credits are charged exactly as through the API.

`agents on`, `agents run` and `plays run` start live work, so they go further.
The API previews the run (what it does, the most it can spend, and whether its
plays can email people or write to a CRM), the quote says the same, and only
`--yes` (or a yes at the prompt) starts it, even at 0 credits. A run whose plays
send or write to a CRM also needs the key's opt-in scope for that
(`sequences:write`, `crm:write`); without it the CLI stops before quoting (exit 3).

`inbox reply`, and a task or Inbox change that writes to the CRM, show who they
reach and need `--yes` (or a yes at the prompt) too; otherwise they exit 7 with
the preview on stdout. A change that stays inside Cleanlist just runs.

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
| 5 | Not enough credits, a spend cap, or the quote is above `--max-credits` |
| 6 | Rate limited |
| 7 | Confirmation required: re-run with `--yes` once the cost is approved |
| 8 | `--wait` timed out; the job is still running (the error shows how to resume) |

`--wait` polls with backoff; `--timeout 10m` caps it.

Retries: every request is retried on a 429, a 5xx or no response, up to 3 tries,
honoring `Retry-After` (a wait over a minute fails at once with exit 6). Each write
sends an `Idempotency-Key` that its own retries reuse, so the API runs it once and
replays the stored answer. A paid call is not resent after a 5xx or no response,
because its quote may already be spent; the error says to check `cleanlist usage`.

## Test mode

```bash
cleanlist login --test --api-key -   # paste a clapi_test_ key (Settings → API keys → Test)
cleanlist --test people search --title "VP Sales"
CLEANLIST_MODE=test cleanlist agents run <agent_id> --yes
```

A test key runs in your workspace's sandbox: providers answer with fixtures, and
nothing is sent to real people, written to a CRM or charged. The CLI prints a TEST
line when the API says it ran in test mode. `--test` refuses a live key.

## Shell completion

```bash
eval "$(cleanlist completion zsh)"    # or bash; fish: cleanlist completion fish > ~/.config/fish/completions/cleanlist.fish
```

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
| `CLEANLIST_MODE` | `test` uses the profile's test key (same as `--test`) |
| `CLEANLIST_HOST` | API base URL (default `https://api.cleanlist.ai`) |
| `CLEANLIST_CONFIG_DIR` | Config directory (default `~/.config/cleanlist`) |
| `CLEANLIST_NO_KEYCHAIN` | Store credentials in the file, not the keychain |
| `CLEANLIST_OAUTH_ISSUER`, `CLEANLIST_OAUTH_CLIENT_ID` | Sign-in server and client, for staging |

## Development

```bash
npm install
npm test             # build + unit tests
npm run check-spec   # every API path the CLI calls is in the public v2 spec (prod by default; pass a spec URL or file)
node dist/cli.js --help
```

Commits follow Conventional Commits; merging to `main` releases to npm
(`feat:` → minor, `fix:` → patch, `!` → major).

## License

MIT
