# Changelog

## 0.2.0 (unreleased)

Breaking: `cleanlist agents` now means GTM agents, as in the portal. The AI-column commands moved to `cleanlist smart-agents`, with the same flags:

| 0.1.0 | 0.2.0 |
|---|---|
| `cleanlist agents run <list> --column ... --prompt ...` | `cleanlist smart-agents run <list> --column ... --prompt ...` |
| `cleanlist agents list --list <id>` | `cleanlist smart-agents list --list <id>` |
| `cleanlist agents results <id>` | `cleanlist smart-agents results <id>` |

The old flags on `agents` now exit 2 and name the new command.

Added:
- `actions list|run|confirm`: every Clu action your key and plan can use. Actions that spend or send return a card and run nothing until confirmed.
- `agents list|get|create|update|run|runs` for GTM agents, `plays list|run|results`, `webhooks list|add|remove`, `sequences list|get|enroll|status|edit`.
- `tasks`, `inbox` and `updates`.
- Data pulls: `jobs search`, `job-changes list|check`, `linkedin posts|engagers`, `companies tech|signals|committee|org`, `meetings list|read`.
- `listen`, `logs`, `batch people|companies`, `mcp install`, `completion`, `use` and `--profile`, `--test` (or `CLEANLIST_MODE=test`).
- `--format table|json|jsonl|csv` on list commands, and `-` reads a file argument from stdin.
- 429s and 5xx are retried up to 3 times, honoring `Retry-After`. Every write sends an `Idempotency-Key` reused across its own retries.

Fixed:
- A paid call that fails after its quote was sent is no longer resent with the spent quote. When the server says it stopped before charging, the CLI gets a fresh quote (same `--yes`, `--max-credits` and prompt rules) and tries once more; otherwise it exits 1 and says to check `cleanlist usage` before re-running.
- `actions run` and `actions confirm` exit non-zero when the action's result is an error (5 for `insufficient_credits`, 3 for `plan_required`, else 1), with the error on stderr.
- Piping into a reader that closes early (`cleanlist ... | head`) exits quietly instead of crashing on EPIPE.
- `job-changes list` and `meetings list` take `--limit`; `meetings read --transcript` asks for the transcript; their tables show the fields the API returns.

## 0.1.0

First release.
