import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Credential } from './config.js';
import { CliError, EXIT } from './errors.js';
import { info } from './output.js';

/**
 * Clerk OAuth for `cleanlist login`: a public client with PKCE over a
 * 127.0.0.1 loopback redirect, or the device grant (`--device`) for SSH.
 * The client is the "Cleanlist CLI" OAuth app; its tokens are accepted by the
 * public API only (cleanse-api allowlists the client_id).
 */
export const OAUTH_ISSUER = process.env.CLEANLIST_OAUTH_ISSUER || 'https://clerk.cleanlist.ai';
// The prod "Cleanlist CLI" Clerk app (public, PKCE). Staging: CLEANLIST_OAUTH_ISSUER
// + CLEANLIST_OAUTH_CLIENT_ID=aHBQ8oyxCDb3rbPy (the dev instance's app).
export const OAUTH_CLIENT_ID = process.env.CLEANLIST_OAUTH_CLIENT_ID || 'gNEM1eGjx95RX9kl';
const SCOPES = 'openid profile email public_metadata user:org:read offline_access';

type OAuthCredential = Extract<Credential, { type: 'oauth' }>;

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
}

async function discover(issuer: string): Promise<Metadata> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new CliError(EXIT.ERROR, `Couldn't read OAuth metadata from ${issuer} (${res.status}).`);
  return (await res.json()) as Metadata;
}

const b64url = (b: Buffer) => b.toString('base64url');

async function tokenRequest(endpoint: string, form: Record<string, string>) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { ok: res.ok, body };
}

function toCredential(body: Record<string, any>, clientId: string, issuer: string, prev?: OAuthCredential): OAuthCredential {
  if (!body.access_token) throw new CliError(EXIT.AUTH, `Sign-in failed: ${body.error_description || body.error || 'no access token returned'}.`);
  return {
    type: 'oauth',
    access_token: body.access_token,
    // Refresh responses may omit the refresh token when it isn't rotated.
    refresh_token: body.refresh_token ?? prev?.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600),
    client_id: clientId,
    issuer,
  };
}

function requireClientId(): string {
  if (!OAUTH_CLIENT_ID) {
    throw new CliError(
      EXIT.AUTH,
      'Browser sign-in is not set up in this build of the CLI yet.',
      'Use an API key: `cleanlist login --api-key` (create one in Settings → API keys), or set CLEANLIST_API_KEY.',
    );
  }
  return OAUTH_CLIENT_ID;
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed too */
  }
}

/** Authorization code + PKCE over a loopback redirect (RFC 8252). */
export async function loginLoopback(): Promise<OAuthCredential> {
  const clientId = requireClientId();
  const meta = await discover(OAUTH_ISSUER);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  let redirectUri = '';
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new CliError(EXIT.TIMEOUT, 'Sign-in timed out after 5 minutes.', 'Run `cleanlist login` again, or use `--device`.'));
    }, 5 * 60_000);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const done = (status: number, msg: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Cleanlist CLI</title><p style="font:16px system-ui;margin:40px">${msg}</p>`);
        clearTimeout(timer);
        server.close();
      };
      const err = url.searchParams.get('error');
      if (err) {
        done(400, 'Sign-in was cancelled. You can close this tab.');
        return reject(new CliError(EXIT.AUTH, `Sign-in failed: ${url.searchParams.get('error_description') || err}.`));
      }
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
        done(400, 'This sign-in link is not valid. Run <code>cleanlist login</code> again.');
        return reject(new CliError(EXIT.AUTH, 'Sign-in response did not match this login attempt.'));
      }
      done(200, 'Signed in to the Cleanlist CLI. You can close this tab.');
      resolve(url.searchParams.get('code')!);
    });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const auth = new URL(meta.authorization_endpoint);
      auth.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      info(`Opening your browser to sign in. If it doesn't open, visit:\n  ${auth}`);
      openBrowser(auth.toString());
    });
  });

  const { body } = await tokenRequest(meta.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  return toCredential(body, clientId, OAUTH_ISSUER);
}

/** Device Authorization Grant (RFC 8628): for SSH sessions and machines without a browser. */
export async function loginDevice(): Promise<OAuthCredential> {
  const clientId = requireClientId();
  const meta = await discover(OAUTH_ISSUER);
  if (!meta.device_authorization_endpoint) throw new CliError(EXIT.AUTH, 'This sign-in server does not offer device login. Use `cleanlist login`.');
  const { ok, body: dev } = await tokenRequest(meta.device_authorization_endpoint, { client_id: clientId, scope: SCOPES });
  if (!ok) throw new CliError(EXIT.AUTH, `Device sign-in failed: ${dev.error_description || dev.error}.`);
  info(`To sign in, open ${dev.verification_uri_complete || dev.verification_uri}\nand confirm the code: ${dev.user_code}`);

  let interval = Number(dev.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(dev.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const { body } = await tokenRequest(meta.token_endpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dev.device_code,
      client_id: clientId,
    });
    if (body.access_token) return toCredential(body, clientId, OAUTH_ISSUER);
    if (body.error === 'slow_down') interval += 5000;
    else if (body.error !== 'authorization_pending') {
      throw new CliError(EXIT.AUTH, `Device sign-in failed: ${body.error_description || body.error}.`);
    }
  }
  throw new CliError(EXIT.TIMEOUT, 'The device code expired before sign-in finished.', 'Run `cleanlist login --device` again.');
}

/** Swap the refresh token for a new access token. */
export async function refresh(cred: OAuthCredential): Promise<OAuthCredential> {
  if (!cred.refresh_token) throw new CliError(EXIT.AUTH, 'Your session expired.', 'Run `cleanlist login`.');
  const meta = await discover(cred.issuer);
  const { ok, body } = await tokenRequest(meta.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: cred.refresh_token,
    client_id: cred.client_id,
  });
  if (!ok) throw new CliError(EXIT.AUTH, 'Your session expired or was revoked.', 'Run `cleanlist login`.');
  return toCredential(body, cred.client_id, cred.issuer, cred);
}

/** Best effort: revoke the refresh token (and with it the grant) at Clerk. */
export async function revoke(cred: OAuthCredential): Promise<void> {
  try {
    const meta = await discover(cred.issuer);
    if (!meta.revocation_endpoint) return;
    for (const [token, hint] of [
      [cred.refresh_token, 'refresh_token'],
      [cred.access_token, 'access_token'],
    ] as const) {
      if (token) await tokenRequest(meta.revocation_endpoint, { token, token_type_hint: hint, client_id: cred.client_id });
    }
  } catch {
    /* offline: the local copy is deleted anyway */
  }
}
