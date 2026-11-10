# Cleanlist CLI

Find B2B people, enrich CSVs and lead lists with verified work emails and phones,
run AI columns, and export, from your terminal. Built for developers working in
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

One profile is one workspace. Add more with `cleanlist login --profile acme`, switch with
`cleanlist use acme`, or pick one per command with `--profile acme` or `CLEANLIST_PROFILE=acme`.
`cleanlist profiles` marks the active one. A profile can also hold a test key
(`cleanlist login --test --api-key clapi_test_…`); `--test` or `CLEANLIST_MODE=test` uses it,
and the CLI prints TEST when the API answers in test mode. `cleanlist whoami` always shows
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

# Run a GTM agent, or call a play like a function and get its records
cleanlist agents run <agent_id> --yes --wait
cleanlist plays run <playbook_id> --inputs '{"email":"jane@acme.com"}' --yes --wait

# Pull signals: job postings, job changes, post engagers, tech users, account data
cleanlist jobs search --title "Head of RevOps" --posted-within-days 30 --yes
cleanlist job-changes list --since 2026-11-01
cleanlist companies tech --tool Outreach --limit 100 --yes --format csv > accounts.csv
cleanlist companies committee acme.com --persona "Sales leadership"
cleanlist meetings list --account acme.com

# Get events at your own URL (signed with Cleanlist-Signature)
cleanlist webhooks add https://example.com/hooks/cleanlist --events play_run.completed,reply.received

# Or stream them live to localhost, signed with this session's secret
cleanlist listen --forward-to http://localhost:3000/webhooks

# Your day: what's new, tasks, replies
cleanlist updates
cleanlist tasks list --status due
cleanlist tasks done <task_id> --outcome Connected --note "Demo booked"
cleanlist inbox list --status needs_reply
cleanlist inbox reply <thread_id> --body "Tuesday at 2 works."

# Up to 1,000 lookups in one call and one quote
cat leads.csv | cleanlist batch people - --fields email,phone --yes

# Your API requests, live
cleanlist logs --status 4xx --follow

# Anything Clu can do: list the actions, run one
cleanlist actions list
cleanlist actions run agents.get --args '{"agent_id":"..."}' --json

# Credits and usage
cleanlist credits
cleanlist usage --group-by tool
```

Run `cleanlist --help` for every command and `cleanlist <command> --help` for flags
and examples. Lists can be named by id or exact name.

## Paying for things

Commands that spend credits (`enrich *`, `smart-agents run`, `agents run`, `plays run`)
first ask the API for a signed quote and show it:

- in a terminal, you're asked `Spend 1,240 credits? [y/N]`;
- with `--yes`, it goes ahead;
- without a terminal and without `--yes`, it exits **7** and prints the quote, so a
  coding agent can show you the cost before re-running with `--yes`;
- `--dry-run` prints the quote and stops; `--max-credits N` refuses anything above N
  (exit 5).

Credits are charged exactly as through the API.

`actions run` works the same way with a card instead of a quote: an action that
spends or sends returns a card and runs nothing. A terminal asks, `--yes` confirms,
and without either it exits **7** with the card, to confirm after the user says yes:
`cleanlist actions confirm <card_id> --session <session_id>`.

`sequences enroll`, `sequences status launch|resume` and `inbox reply` email real
people. Without `--yes` the API answers with who would be contacted and nothing is
sent: a terminal asks, anything else exits 7.

## Output and exit codes

Tables in a terminal, JSON when piped (`--json`, `--format jsonl|csv` to choose).
Data goes to stdout, progress to stderr (`-q` silences it). Errors are JSON on stderr
when piped, with a `fix` hint. A file argument of `-` reads stdin. Rate limits (429) and
server errors (5xx) are retried up to 3 tries, waiting as long as `Retry-After` says (up to
a minute), and every write carries an `Idempotency-Key` reused by its own retries, so a
retried write runs once.

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Unexpected or server error |
| 2 | Bad input (flags, validation, ambiguous list name) |
| 3 | Not signed in, revoked, or the plan has no API access |
| 4 | Not found |
| 5 | Not enough credits, or the quote is above `--max-credits` |
| 6 | Rate limited (after retries) |
| 7 | Confirmation required: re-run with `--yes` once the cost is approved |
| 8 | `--wait` timed out; the job is still running (the error shows how to resume) |

`--wait` polls with backoff and honors `Retry-After`; `--timeout 10m` caps it.

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
`cleanlist mcp install claude-code|claude-desktop|cursor|codex` adds the hosted server
(sign-in in the app), or a local one with `--api-key clapi_…`. It shows the change first.

Shell completion: `eval "$(cleanlist completion zsh)"` (also `bash`, `fish`).

## Environment

| Variable | Use |
|---|---|
| `CLEANLIST_API_KEY` | API key; overrides any saved login |
| `CLEANLIST_PROFILE` | Profile to use |
| `CLEANLIST_MODE` | `test` uses the profile's test key |
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
