import { type Credential, saveCredential } from './config.js';
import { CliError, EXIT, exitCodeForStatus } from './errors.js';
import { refresh } from './oauth.js';
import { VERSION } from './version.js';

type Query = Record<string, string | number | boolean | undefined | null>;

export interface ApiResult<T = any> {
  status: number;
  data: T;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thin client for the public v2 API. Bodies go out and come back as the API defines them. */
export class Api {
  constructor(
    readonly baseUrl: string,
    private cred: Credential | undefined,
    private readonly profile: string,
    /** Where the credential came from; only stored credentials get refreshed and saved. */
    private readonly stored: boolean,
  ) {}

  get authType() {
    return this.cred?.type;
  }

  private async token(): Promise<string> {
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
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (e) {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new CliError(EXIT.ERROR, `Couldn't reach ${url.origin}: ${(e as Error).message}`);
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
        await this.refresh();
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after')) || data?.error?.retry_after_ms / 1000 || 2 ** attempt;
        await sleep(Math.min(retryAfter, 30) * 1000);
        continue;
      }
      throw toError(res.status, data);
    }
  }
}

/** Map an API error body (`{error: {code, problem, fix}}` or FastAPI `{detail}`) to a CliError. */
export function toError(status: number, data: any): CliError {
  const env = data?.error;
  const detail = data?.detail;
  const message =
    env?.problem ||
    env?.message ||
    (typeof detail === 'string' ? detail : detail?.message) ||
    (Array.isArray(detail) ? detail.map((d: any) => `${(d.loc ?? []).slice(1).join('.')}: ${d.msg}`).join('; ') : '') ||
    `HTTP ${status}`;
  const body = typeof data === 'object' && data ? data : { error: { message: String(data) } };
  const fix = env?.fix ?? (status === 401 ? 'Run `cleanlist login`, or check CLEANLIST_API_KEY.' : undefined);
  return new CliError(exitCodeForStatus(status, env?.code), message, fix, body);
}
