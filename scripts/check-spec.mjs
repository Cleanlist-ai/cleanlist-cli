#!/usr/bin/env node
// Fails if the CLI calls an API path that isn't in the public v2 spec, so the
// CLI only ever uses documented operations and notices when one is removed.
// Usage: node scripts/check-spec.mjs [spec-url]   (default: production)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] || 'https://api.cleanlist.ai/openapi-public-v2.json';
const spec = await (await fetch(url)).json();
const toRe = (p) => new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+') + '$');
const documented = Object.keys(spec.paths).map(toRe);

// New in Cleanlist-ai/cleanse-api#2904 (actions, GTM agents, plays, webhooks,
// sequences, tasks, Inbox, updates). Reported as pending until the public spec
// has them; delete each line once it ships.
const NEW_IN_2904 = [
  '/api/v2/actions',
  '/api/v2/actions/{name}',
  '/api/v2/actions/confirm',
  '/api/v2/gtm-agents',
  '/api/v2/gtm-agents/{agent_id}',
  '/api/v2/gtm-agents/{agent_id}/status',
  '/api/v2/gtm-agents/{agent_id}/run',
  '/api/v2/gtm-agents/{agent_id}/runs',
  '/api/v2/gtm-runs/{run_id}',
  '/api/v2/gtm-runs/{run_id}/records',
  '/api/v2/plays',
  '/api/v2/plays/{playbook_id}/run',
  '/api/v2/webhooks',
  '/api/v2/webhooks/{webhook_id}',
  '/api/v2/sequences',
  '/api/v2/sequences/{id}',
  '/api/v2/sequences/{id}/enroll',
  '/api/v2/sequences/{id}/status',
  '/api/v2/gtm-tasks',
  '/api/v2/gtm-tasks/{task_id}',
  '/api/v2/inbox/threads',
  '/api/v2/inbox/threads/{thread_id}',
  '/api/v2/inbox/threads/{thread_id}/reply',
  '/api/v2/updates',
  // Developer experience (C10, C11).
  '/api/v2/logs',
  '/api/v2/batch/people/lookup',
  '/api/v2/batch/companies/lookup',
  // A WebSocket route: OpenAPI never lists it, so it stays here.
  '/api/v2/events/listen',
].map(toRe);

const files = readdirSync('src', { recursive: true }).filter((f) => f.endsWith('.ts'));
const used = new Set();
for (const f of files) {
  for (const m of readFileSync(join('src', f), 'utf8').matchAll(/[`'"](\/api\/v2\/[^`'"?]*)[`'"]/g)) {
    used.add(m[1].replace(/\$\{[^}]+\}/g, 'X'));
  }
}

const undocumented = [...used].filter((p) => !documented.some((re) => re.test(p)));
const pending = undocumented.filter((p) => NEW_IN_2904.some((re) => re.test(p)));
const missing = undocumented.filter((p) => !pending.includes(p));
console.log(`spec ${spec.info.version}: ${used.size} paths used, ${missing.length} not documented, ${pending.length} pending cleanse-api#2904`);
for (const p of pending) console.log(`  pending: ${p}`);
for (const p of missing) console.log(`  missing: ${p}`);
process.exit(missing.length ? 1 : 0);
