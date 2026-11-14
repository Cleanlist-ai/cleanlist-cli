#!/usr/bin/env node
// Fails if the CLI calls an API path that isn't in the public v2 spec, so the
// CLI only ever uses documented operations and notices when one is removed.
// Usage: node scripts/check-spec.mjs [spec-url]   (default: production)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] || 'https://api.cleanlist.ai/openapi-public-v2.json';
const spec = await (await fetch(url)).json();
// A WebSocket route (`cleanlist listen`): OpenAPI never lists one.
const WEBSOCKETS = ['/api/v2/events/listen'];
const documented = [...Object.keys(spec.paths), ...WEBSOCKETS].map((p) => new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+') + '$'));

const files = readdirSync('src', { recursive: true }).filter((f) => f.endsWith('.ts'));
const used = new Set();
for (const f of files) {
  for (const m of readFileSync(join('src', f), 'utf8').matchAll(/[`'"](\/api\/v2\/[^`'"?]*)[`'"]/g)) {
    used.add(m[1].replace(/\$\{[^}]+\}/g, 'X'));
  }
}

const missing = [...used].filter((p) => !documented.some((re) => re.test(p)));
console.log(`spec ${spec.info.version}: ${used.size} paths used, ${missing.length} not documented`);
for (const p of missing) console.log(`  missing: ${p}`);
process.exit(missing.length ? 1 : 0);
