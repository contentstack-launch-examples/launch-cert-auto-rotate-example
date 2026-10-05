import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { ValidationError } from './errors.js';

/**
 * All configuration lives in one file, written by `setup`: /etc/launch-cert-rotate/env (mode 600).
 * Values already set in the environment override it.
 */
export const KEYS = {
  host: 'LAUNCH_HOST',
  authtoken: 'LAUNCH_AUTHTOKEN',
  orgUid: 'LAUNCH_ORG_UID',
  projectUid: 'LAUNCH_PROJECT_UID',
  environmentUid: 'LAUNCH_ENVIRONMENT_UID',
  /** Comma-separated Launch domains that share the certificate. */
  domains: 'LAUNCH_DOMAINS',
  hostingerToken: 'HOSTINGER_API_TOKEN',
  email: 'LETSENCRYPT_EMAIL',
} as const;

export type Env = Record<string, string | undefined>;

export interface Config {
  host: string;
  authtoken: string;
  orgUid: string;
  projectUid: string;
  environmentUid: string;
  domains: string[];
}

export function paths(env: Env) {
  const configDir = env.LAUNCH_CONFIG_DIR ?? '/etc/launch-cert-rotate';
  const letsencryptDir = env.LETSENCRYPT_DIR ?? '/etc/letsencrypt';
  return { configDir, configFile: join(configDir, 'env'), letsencryptDir };
}

/** Saved settings, or {} before setup has run. */
export function readConfigFile(env: Env): Record<string, string> {
  const file = paths(env).configFile;
  try {
    return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return {};
    if (code === 'EACCES') throw new ValidationError(`${file} is readable by root only.`, 'Run the command with sudo.');
    throw new ValidationError(`Could not read ${file} (${code ?? 'unknown error'}).`);
  }
}

export function writeConfigFile(env: Env, values: Env): void {
  const file = paths(env).configFile;
  const lines = ['# Written by `launch-cert-rotate setup`. Keep private (mode 600).'];
  for (const [k, v] of Object.entries(values)) {
    if (v) lines.push(/^[\w.:/@,+-]+$/.test(v) ? `${k}=${v}` : `${k}="${v.replace(/["\\]/g, '\\$&')}"`);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Environment + saved settings, validated. */
export function loadConfig(env: Env): Config & { values: Env } {
  const values: Env = { ...readConfigFile(env), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
  const get = (key: string) => values[key]?.trim() ?? '';
  const missing = [KEYS.host, KEYS.authtoken, KEYS.orgUid, KEYS.projectUid, KEYS.environmentUid].filter((k) => !get(k));
  if (missing.length > 0) {
    throw new ValidationError(`Missing configuration: ${missing.join(', ')}.`, 'Run: sudo launch-cert-rotate setup');
  }
  if (!/^https?:\/\/[^\s/]+/.test(get(KEYS.host))) {
    throw new ValidationError(`${KEYS.host} must be a URL like https://launch-api.contentstack.com`);
  }
  return {
    host: get(KEYS.host).replace(/\/+$/, ''),
    authtoken: get(KEYS.authtoken),
    orgUid: get(KEYS.orgUid),
    projectUid: get(KEYS.projectUid),
    environmentUid: get(KEYS.environmentUid),
    domains: get(KEYS.domains).split(',').map((d) => d.trim()).filter(Boolean),
    values,
  };
}
