import { type Credential, saveCredential } from './config.js';
import { CliError, EXIT, exitCodeForStatus } from './errors.js';
import { refresh } from './oauth.js';
import { VERSION } from './version.js';

type Query = Record<string, string | number | boolean | undefined | null>;

export interface ApiResult<T = any> {
  status: number;
  data: T;
}

/**
 * Only a GET is ever retried, and only on a gateway error (or no response at
 * all). A POST, PATCH or DELETE is sent once: there are no idempotency keys
 * yet, so a resent write could run twice.
 */
const RETRYABLE = new Set([502, 503, 504]);
const MAX_TRIES = 3;
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

    const retries = method.toUpperCase() === 'GET';
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
        if (retries && attempt + 1 < MAX_TRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new CliError(
          EXIT.ERROR,
          `Couldn't reach ${url.origin}: ${(e as Error).message}`,
          retries ? undefined : 'It was not resent. The write may still have gone through: check before running it again.',
        );
      }

      const text = await res.text();
      let data: any = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* non-JSON body */
      }
      if (res.ok) return { status: res.status, data };

      // A stored OAuth token can be revoked or expire early: refresh once. The
      // server refused before doing anything, so this resend is safe for writes too.
      if (res.status === 401 && this.cred?.type === 'oauth' && !refreshed) {
        refreshed = true;
        await this.refresh();
        continue;
      }
      if (retries && RETRYABLE.has(res.status) && attempt + 1 < MAX_TRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || data?.error?.retry_after_ms / 1000 || 2 ** attempt;
        await sleep(Math.min(retryAfter, 30) * 1000);
        continue;
      }
      throw toError(res.status, data);
    }
  }
}

/** Refusals the CLI can't work around: say who can do it, and where. */
const REFUSAL_FIX: Record<string, (env: any) => string> = {
  person_required: () => 'Only a person can do this, in the Cleanlist app (or through the MCP, where the app asks them). It cannot be done from the CLI.',
  opt_in_scope_required: (env) => {
    const scope = env?.details?.required_scope ?? env?.required_scope;
    return `This API key needs the ${scope ? `"${scope}"` : 'matching'} scope. In the Cleanlist portal open Settings → API keys, edit this key and tick ${scope ? `"${scope}"` : 'that scope'}, then run it again.`;
  },
};

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
  const fix = REFUSAL_FIX[env?.code]?.(env) ?? env?.fix ?? (status === 401 ? 'Run `cleanlist login`, or check CLEANLIST_API_KEY.' : undefined);
  return new CliError(exitCodeForStatus(status, env?.code), message, fix, body);
}
