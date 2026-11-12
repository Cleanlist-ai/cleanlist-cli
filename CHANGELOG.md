# Changelog

## 0.2.0

### Breaking: `agents` is now GTM agents

`cleanlist agents` now means GTM agents, as in the Cleanlist app. The AI-column
commands moved to `cleanlist smart-agents`, with the same flags:

| 0.1.0 | 0.2.0 |
|---|---|
| `cleanlist agents run <list> --column ... --prompt ...` | `cleanlist smart-agents run <list> --column ... --prompt ...` |
| `cleanlist agents list --list <id>` | `cleanlist smart-agents list --list <id>` |
| `cleanlist agents results <id>` | `cleanlist smart-agents results <id>` |

`agents run` and `agents results`, and the old flags on `agents list`, now exit 2
and name the new command.

**`cleanlist agents list --json` changed shape without an error.** A script that
reads it gets a different JSON document and keeps running. Switch it to
`cleanlist smart-agents list --json` to keep the old output.

Before (0.1.0), an object with smart-agent (AI column) runs:

```json
{
  "task_id": "task_9f2c1a",
  "timestamp_ms": 1751404800000,
  "agent_instructions": null,
  "usage": null,
  "message": null,
  "runs": [
    {
      "task_id": "run_7c2a91",
      "list_id": "9c1f7e2a-4b6d-4f21-9a3e-2b7c8d1e5f04",
      "column_name": "Fit Research",
      "agent_type": "custom_ai",
      "status": "completed",
      "total": 100,
      "processed": 100,
      "failed": 2,
      "created_at": "2026-07-01T20:40:00Z"
    }
  ],
  "total": 1
}
```

After (0.2.0), a JSON array of GTM agents, newest first (fields abridged):

```json
[
  {
    "id": "8f0c2d6e-...",
    "name": "Inbound follow-up",
    "description": null,
    "status": "paused",
    "playIds": ["..."],
    "triggers": [],
    "nextRunAt": null,
    "lastRunAt": "2026-11-10T14:00:00Z",
    "createdAt": "2026-11-01T09:00:00Z",
    "modifiedAt": "2026-11-10T14:05:00Z"
  }
]
```

### Added

These call the v2 public actions and GTM agent routes. They return 404 until the
Cleanlist API turns them on for your workspace.

- `smart-agents run|list|results`: the AI-column commands, under their new name.
- `agents list|get|create|update|off|runs`: GTM agents. `plays results <run_id>`
  shows a run's status and records, with what each step wrote (`--wait` to wait
  for it).
- `actions list|run|confirm`: every Clu action your key and plan can use, by group
  (`lists`, `agents`, `plays`, `skills`, `sequences`, `crm`). An action that spends,
  sends, deletes or writes to a CRM returns a card and runs nothing until
  confirmed: `--yes` confirms it, a terminal asks, anything else exits 7 with the
  card. `--max-credits` caps it.
- `webhooks list|add|remove`: subscribe a public https URL to events. The signing
  secret is shown once.
- `mcp install claude-code|claude-desktop|cursor|codex`: add the Cleanlist MCP
  server to an AI app, hosted with sign-in by default or locally with `--api-key`.
  It shows the config change and writes it once confirmed.
- Refusals say who can act and where. `person_required` (turning an agent on,
  running it now, its limits) says a person does it in the Cleanlist app.
  `opt_in_scope_required` names the scope (`lists:delete`, `sequences:write`,
  `crm:write`) to tick on the key in Settings → API keys. Both exit 3.

There is no command to turn an agent on, run an agent or play now, or set its
limits: the API leaves those to a person in the Cleanlist app.

### Changed

- Retries: only a GET is retried, up to 3 tries, on 502, 503 or 504 (or when no
  response came back). A POST, PATCH or DELETE is sent once and never resent,
  since a resent write could run twice. 0.1.0 also retried writes, and 429s; a 429
  now exits 6 straight away.
- `mcp install` updates an existing Cleanlist entry in place, never removing it
  first, and leaves every other server and setting as it was. For Claude Code it
  edits the user config (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`)
  instead of running `claude mcp remove` then `claude mcp add`. Each config is
  written to a temporary file and renamed over the old one, so a failed write
  leaves it as it was.
- `--max-credits` must be a number (`1000`); anything else exits 2 instead of
  being ignored.

## 0.1.0

First release.
