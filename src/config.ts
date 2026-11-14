import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.cleanlist.ai';

/** One profile = one Cleanlist workspace (org) = one credential. */
export interface Profile {
  apiUrl?: string;
  organizationId?: string;
  organizationName?: string;
  email?: string;
  authType?: 'api_key' | 'oauth';
  /** A test key (clapi_test_...) is saved for `--test`. */
  hasTestKey?: boolean;
}

interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export type Credential =
  | { type: 'api_key'; key: string }
  | {
      type: 'oauth';
      access_token: string;
      refresh_token?: string;
      /** Unix seconds. */
      expires_at: number;
      client_id: string;
      issuer: string;
    };

export const configDir = () =>
  process.env.CLEANLIST_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleanlist');

const configPath = () => join(configDir(), 'config.json');
const credsPath = () => join(configDir(), 'credentials.json');

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(path: string, data: unknown): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadConfig(): ConfigFile {
  return readJson<ConfigFile>(configPath(), { profiles: {} });
}

export function saveProfile(name: string, profile: Profile, makeDefault: boolean): void {
  const cfg = loadConfig();
  cfg.profiles[name] = profile;
  if (makeDefault || !cfg.defaultProfile) cfg.defaultProfile = name;
  writePrivate(configPath(), cfg);
}

export function removeProfile(name: string): void {
  const cfg = loadConfig();
  delete cfg.profiles[name];
  if (cfg.defaultProfile === name) cfg.defaultProfile = Object.keys(cfg.profiles)[0];
  writePrivate(configPath(), cfg);
}

/** Make an existing profile the one used when --profile and CLEANLIST_PROFILE are unset. */
export function useProfile(name: string): boolean {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) return false;
  cfg.defaultProfile = name;
  writePrivate(configPath(), cfg);
  return true;
}

/** Where a profile's test key is kept, next to its live credential. */
export const testCredentialName = (profile: string) => `${profile}:test`;

export function profileName(flag?: string): string {
  return flag || process.env.CLEANLIST_PROFILE || loadConfig().defaultProfile || 'default';
}

// ---------------------------------------------------------------------------
// Secrets: the OS keychain when there is one, else a 0600 file (like `gh`).
// macOS `security` and libsecret `secret-tool` are called directly, so the CLI
// has no native dependencies.
// ponytail: macOS passes the secret on argv for a few ms (as go-keyring does);
// switch to a native keyring binding if that ever matters.
// ---------------------------------------------------------------------------

const SERVICE = 'cleanlist-cli';
type Store = 'macos' | 'libsecret' | 'file';

function store(): Store {
  if (process.env.CLEANLIST_NO_KEYCHAIN) return 'file';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    try {
      execFileSync('secret-tool', ['--version'], { stdio: 'ignore' });
      return 'libsecret';
    } catch {
      /* not installed */
    }
  }
  return 'file';
}

const run = (cmd: string, args: string[], input?: string) =>
  execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });

export function saveCredential(profile: string, cred: Credential): void {
  const secret = JSON.stringify(cred);
  const s = store();
  try {
    if (s === 'macos') return void run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', profile, '-w', secret]);
    if (s === 'libsecret') {
      return void run('secret-tool', ['store', '--label', `Cleanlist CLI (${profile})`, 'service', SERVICE, 'account', profile], secret);
    }
  } catch {
    /* keychain locked or unavailable: fall back to the file */
  }
  const all = readJson<Record<string, Credential>>(credsPath(), {});
  all[profile] = cred;
  writePrivate(credsPath(), all);
}

export function loadCredential(profile: string): Credential | undefined {
  const s = store();
  try {
    if (s === 'macos') return JSON.parse(run('security', ['find-generic-password', '-s', SERVICE, '-a', profile, '-w']).trim());
    if (s === 'libsecret') {
      const v = run('secret-tool', ['lookup', 'service', SERVICE, 'account', profile]).trim();
      if (v) return JSON.parse(v);
    }
  } catch {
    /* not in the keychain */
  }
  return existsSync(credsPath()) ? readJson<Record<string, Credential>>(credsPath(), {})[profile] : undefined;
}

export function deleteCredential(profile: string): void {
  const s = store();
  try {
    if (s === 'macos') run('security', ['delete-generic-password', '-s', SERVICE, '-a', profile]);
    if (s === 'libsecret') run('secret-tool', ['clear', 'service', SERVICE, 'account', profile]);
  } catch {
    /* nothing stored */
  }
  if (existsSync(credsPath())) {
    const all = readJson<Record<string, Credential>>(credsPath(), {});
    delete all[profile];
    writePrivate(credsPath(), all);
  }
}
