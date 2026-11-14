import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export const quote = { quote_id: 'qte_1', estimated_cost: 40, available_credits: 1000, row_count: 1, sufficient: true, expires_at: 0, tool: 'x' };

/** A ctx whose API records every call and answers from `routes` ("METHOD path" → body, or a function of the body or query). */
export function fakeCtx(args, opts, routes) {
  const calls = [];
  const answer = async (method, path, body, query) => {
    calls.push({ method, path, body, ...(query ? { query } : {}) });
    const r = routes[`${method} ${path}`];
    if (r === undefined) throw new Error(`unexpected ${method} ${path}`);
    return { status: 200, data: typeof r === 'function' ? r(body ?? query) : r };
  };
  return {
    calls,
    args,
    opts: { 'no-input': true, ...opts },
    log() {},
    api: {
      get: (path, query) => answer('GET', path, undefined, query),
      post: (path, body) => answer('POST', path, body),
      request: (method, path, o = {}) => answer(method, path, o.body, o.query),
    },
  };
}

/**
 * Run the built CLI with no TTY. CLEANLIST_MODE is cleared so a shell that
 * exports it doesn't change the run. With `handler`, a local API answers and
 * `--api-url` points at it.
 */
export async function runCli(args, { env = {}, input, handler } = {}) {
  let server;
  if (handler) {
    server = createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    args = [...args, '--api-url', `http://127.0.0.1:${server.address().port}`];
  }
  try {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, CI: '1', CLEANLIST_API_KEY: 'test', CLEANLIST_MODE: '', ...env } });
    child.stdin.end(input ?? '');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((r) => child.on('close', r));
    return { code, stdout, stderr };
  } finally {
    server?.close();
  }
}
