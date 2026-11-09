/** Exit codes. Documented in README and `cleanlist help`; agents branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1, // unexpected / 5xx after retries
  USAGE: 2, // bad flags, 400/422, ambiguous list name
  AUTH: 3, // 401/403: no credentials, revoked, plan/trial without API access
  NOT_FOUND: 4,
  CREDITS: 5, // insufficient balance, or quote above --max-credits
  RATE_LIMITED: 6,
  CONFIRM: 7, // paid/destructive action needs --yes and there is no TTY to ask
  TIMEOUT: 8, // --wait gave up; the job is still running
} as const;

export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
    readonly fix?: string,
    /** Server error envelope (`{error: {...}}`) or extra machine-readable detail. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** The API's error `code` (e.g. `insufficient_credits`), when there is one. */
  get apiCode(): string | undefined {
    const err = this.detail?.error as { code?: unknown } | undefined;
    return typeof err?.code === 'string' ? err.code : undefined;
  }
}

export function exitCodeForStatus(status: number, code?: string): number {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 402 || code === 'insufficient_credits') return EXIT.CREDITS;
  if (status === 429) return EXIT.RATE_LIMITED;
  if (status === 400 || status === 409 || status === 413 || status === 422) return EXIT.USAGE;
  return EXIT.ERROR;
}
