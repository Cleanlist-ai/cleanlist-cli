import { randomUUID } from 'node:crypto';
import { type Credential, saveCredential } from './config.js';
import { CliError, EXIT, exitCodeForStatus } from './errors.js';
import { refresh } from './oauth.js';
import { VERSION } from './version.js';

type Query = Record<string, string | number | boolean | undefined | null>;

export interface ApiResult<T = any> {
  status: number;
  data: T;
}

const WRITES = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/** Tries per request for 429, 5xx, a write still running elsewhere, and network errors. */
export const MAX_TRIES = 3;
/** Longer waits than this aren't worth blocking on: fail with exit 6 and say when to retry. */
const MAX_WAIT_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before retry number `attempt` (0-based): the server's
 * retry_after_ms, else Retry-After (seconds or an HTTP date), else 1s, 2s, 4s
 * with jitter.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null, body: any): number {
  const ms = Number(body?.error?.retry_after_ms);
  if (Number.isFinite(ms) && ms > 0) return ms;
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return 1000 * 2 ** attempt * (0.75 + Math.random() / 2);
}

const retryable = (status: number, body: any) =>
  status === 429 || status >= 500 || (status === 409 && body?.error?.code === 'idempotency_in_progress');

/** Thin client for the public v2 API. Bodies go out and come back as the API defines them. */
export class Api {
  constructor(
    readonly baseUrl: string,
    private cred: Credential | undefined,
    private readonly profile: string,
    /** Where the credential came from; only stored credentials get refreshed and saved. */
    private readonly stored: boolean,
    /** Called once, on the first response that says it ran in test mode. */
    private readonly onTestMode?: () => void,
  ) {}

  /** `test` once the server has answered `Cleanlist-Mode: test`. */
  mode: 'live' | 'test' = 'live';

  get authType() {
    return this.cred?.type;
  }

  /** A bearer token for this credential, refreshed when an OAuth one is about to expire. */
  async token(): Promise<string> {
    const c = this.cred;
    if (!c) {
      throw new CliError(
        EXIT.AUTH,
        'Not signed in.',
        'Run `cleanlist login`, or set CLEANLIST_API_KEY (create a key in Settings → API keys).',
      );
    }
    if (c.type === 'api_key') return c.key;
    if (c.expires_at - 60 < Date.now() / 1000) await this.refresh();
    return (this.cred as Extract<Credential, { type: 'oauth' }>).access_token;
  }

  private async refresh(): Promise<void> {
    if (this.cred?.type !== 'oauth') return;
    this.cred = await refresh(this.cred);
    if (this.stored) saveCredential(this.profile, this.cred);
  }

  async get<T = any>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }

  async post<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('POST', path, { body, query });
  }

  async request<T = any>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<ApiResult<T>> {
    const url = new URL(this.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    // One key per call, reused by its own retries, so a retried write runs once.
    const idempotencyKey = WRITES.has(method.toUpperCase()) ? randomUUID() : undefined;
    // A quote is single-use and a route spends it before its work, so resending it after a
    // 5xx or a dropped connection fails as already used and hides the real error. Those go
    // back to the caller (`spend` gets a fresh quote); a 429 comes before the route and retries.
    const quoteBound = Boolean((opts.body as { quote_id?: unknown } | undefined)?.quote_id);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(); // outside the try: a missing credential isn't a network error
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'user-agent': `cleanlist-cli/${VERSION} node/${process.version}`,
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (e) {
        if (attempt + 1 < MAX_TRIES && !quoteBound) {
          await sleep(retryDelayMs(attempt, null, undefined));
          continue;
        }
        throw new CliError(EXIT.ERROR, `Couldn't reach ${url.origin}: ${(e as Error).message}`, quoteBound ? MAYBE_SPENT : undefined);
      }

      if ((res.headers.get('cleanlist-mode') ?? res.headers.get('x-cleanlist-mode')) === 'test' && this.mode !== 'test') {
        this.mode = 'test';
        this.onTestMode?.();
      }
      const text = await res.text();
      let data: any = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* non-JSON body */
      }
      if (res.ok) return { status: res.status, data };

      // A stored OAuth token can be revoked or expire early: refresh once.
      if (res.status === 401 && this.cred?.type === 'oauth' && !refreshed) {
        refreshed = true;
        attempt--; // not a retry of a failure
        await this.refresh();
        continue;
      }
      if (retryable(res.status, data) && !(quoteBound && res.status >= 500) && attempt + 1 < MAX_TRIES) {
        const wait = retryDelayMs(attempt, res.headers.get('retry-after'), data);
        if (wait <= MAX_WAIT_MS) {
          await sleep(wait);
          continue;
        }
      }
      const err = toError(res.status, data);
      // The server didn't say it stopped before charging: the call may have run.
      if (quoteBound && res.status >= 500 && data?.error?.retryable !== true) {
        throw new CliError(err.exitCode, err.message, MAYBE_SPENT, err.detail);
      }
      throw err;
    }
  }
}

const MAYBE_SPENT = 'It may have run and spent its quote. Check `cleanlist usage` before running it again; a re-run gets a fresh quote.';

/** Map an API error body (`{error: {code, problem, fix}}` or FastAPI `{detail}`) to a CliError. */
export function toError(status: number, data: any): CliError {
  const env = data?.error;
  const detail = data?.detail;
  // Validation errors put the useful part in details.errors: name the field.
  const first = env?.details?.errors?.[0];
  const field = (first?.loc ?? []).filter((x: unknown) => x !== 'body').join('.');
  const where = first && !String(env?.problem ?? '').includes(field) ? ` (${field}: ${first.msg})` : '';
  const message =
    (env?.problem && env.problem + where) ||
    env?.message ||
    (typeof detail === 'string' ? detail : detail?.message) ||
    (Array.isArray(detail) ? detail.map((d: any) => `${(d.loc ?? []).slice(1).join('.')}: ${d.msg}`).join('; ') : '') ||
    `HTTP ${status}`;
  const body = typeof data === 'object' && data ? data : { error: { message: String(data) } };
  const fix = env?.fix ?? (status === 401 ? 'Run `cleanlist login`, or check CLEANLIST_API_KEY.' : undefined);
  return new CliError(exitCodeForStatus(status, env?.code), message, fix, body);
}
