import { Resolver, resolve4, resolveNs } from 'node:dns/promises';
import { KEYS, readConfigFile, type Env } from './config.js';
import { AppError, ValidationError } from './errors.js';
import type { FetchLike } from './launchClient.js';

/**
 * certbot DNS hook for Hostinger. certbot runs it (as `launch-cert-rotate hostinger-hook auth|cleanup`)
 * with CERTBOT_DOMAIN and CERTBOT_VALIDATION set:
 *   auth    → create the TXT record _acme-challenge.<domain> and wait until Hostinger's nameservers serve it
 *   cleanup → delete it again
 * API: https://developers.hostinger.com (DNS → zones).
 */
const API = 'https://developers.hostinger.com/api/dns/v1/zones';

/** The DNS zone a domain lives in. Assumes example.com-style zones; set HOSTINGER_ZONE for others (e.g. example.co.uk). */
export function zoneOf(domain: string, env: Env): string {
  return env.HOSTINGER_ZONE ?? domain.split('.').slice(-2).join('.');
}

async function hostinger(token: string, zone: string, method: 'GET' | 'PUT' | 'DELETE', body: unknown, fetchImpl: FetchLike) {
  const res = await fetchImpl(`${API}/${zone}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new ValidationError('Hostinger rejected the API token.', 'Create a new one in hPanel → Profile → API and re-run setup.');
  if (!res.ok) throw new AppError(`Hostinger ${method} ${zone} failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Check a token can read the zone (used by setup). */
export async function checkHostingerToken(token: string, zone: string, fetchImpl: FetchLike): Promise<void> {
  await hostinger(token, zone, 'GET', undefined, fetchImpl);
}

/** True when every authoritative nameserver of `zone` returns `value` for the TXT record `fqdn`. */
async function visibleEverywhere(zone: string, fqdn: string, value: string): Promise<boolean> {
  for (const ns of await resolveNs(zone)) {
    const resolver = new Resolver();
    resolver.setServers(await resolve4(ns));
    const records = await resolver.resolveTxt(fqdn).catch(() => [] as string[][]);
    if (!records.some((parts) => parts.join('') === value)) return false;
  }
  return true;
}

export async function hostingerHook(
  mode: string,
  env: Env,
  log: (line: string) => void,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<void> {
  const token = env[KEYS.hostingerToken] ?? readConfigFile(env)[KEYS.hostingerToken];
  const domain = env.CERTBOT_DOMAIN?.replace(/^\*\./, '');
  if (!token) throw new ValidationError(`${KEYS.hostingerToken} is not set. Run: sudo launch-cert-rotate setup`);
  if (!domain) throw new ValidationError('CERTBOT_DOMAIN is not set; this command is run by certbot.');

  const zone = zoneOf(domain, env);
  if (domain !== zone && !domain.endsWith(`.${zone}`)) throw new ValidationError(`${domain} is not in the zone ${zone}; set HOSTINGER_ZONE.`);
  const name = domain === zone ? '_acme-challenge' : `_acme-challenge.${domain.slice(0, -zone.length - 1)}`;
  const fqdn = `${name}.${zone}`;

  if (mode === 'cleanup') {
    log(`Removing TXT ${fqdn}`);
    await hostinger(token, zone, 'DELETE', { filters: [{ name, type: 'TXT' }] }, fetchImpl);
    return;
  }
  if (mode !== 'auth') throw new ValidationError('Usage: launch-cert-rotate hostinger-hook auth|cleanup');

  const value = env.CERTBOT_VALIDATION;
  if (!value) throw new ValidationError('CERTBOT_VALIDATION is not set; this command is run by certbot.');
  log(`Adding TXT ${fqdn}`);
  // overwrite=false appends, so example.com and *.example.com can both validate in one run.
  await hostinger(token, zone, 'PUT', { overwrite: false, zone: [{ name, type: 'TXT', ttl: 300, records: [{ content: value }] }] }, fetchImpl);

  const timeoutSeconds = Number(env.HOSTINGER_PROPAGATION_TIMEOUT ?? 300);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (timeoutSeconds > 0 && !(await visibleEverywhere(zone, fqdn, value))) {
    if (Date.now() > deadline) throw new AppError(`TXT ${fqdn} is not visible on Hostinger's nameservers after ${timeoutSeconds}s.`);
    log('Waiting for the TXT record to appear on Hostinger\'s nameservers...');
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  log('TXT record is live.');
}
