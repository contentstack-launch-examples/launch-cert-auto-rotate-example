import { loadCertificate } from './cert.js';
import { ValidationError, VerificationError } from './errors.js';
import type { LaunchClient, LaunchDomain } from './launchClient.js';
import { silentLogger, type Logger } from './logger.js';

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'none');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Expiry dates this close count as the same certificate. */
const SAME_CERT_MS = 2 * 60_000;

export interface UploadOptions {
  /** Switch a domain that is on Launch's automatic SSL to this certificate. */
  switchFromAutomatic?: boolean;
  /** Upload even if Launch already has a certificate with this expiry. */
  force?: boolean;
  /** How long to wait for Launch to report SSL as active. */
  waitSeconds?: number;
}

async function findDomain(client: LaunchClient, url: string): Promise<LaunchDomain> {
  const domain = await client.findDomain(url);
  if (!domain) throw new ValidationError(`${url} is not a domain in this Launch environment.`, 'Add it in Launch → Settings → Domains, or re-run setup.');
  return domain;
}

const isCustom = (d: LaunchDomain | undefined) => d?.sslMethod?.toUpperCase() === 'CUSTOM';

/**
 * Make sure Launch serves the certificate in certPath/keyPath on `url`:
 * check it locally → skip if Launch already has it → upload → wait for SSL → confirm the stored expiry.
 * Returns a one-line summary.
 */
export async function uploadIfNewer(
  client: LaunchClient,
  url: string,
  certPath: string,
  keyPath: string,
  opts: UploadOptions = {},
  logger: Logger = silentLogger,
): Promise<string> {
  const cert = loadCertificate(certPath, keyPath, url);
  logger.addSecret(cert.key);
  const domain = await findDomain(client, url);

  if (!isCustom(domain) && !opts.switchFromAutomatic) {
    return `skipped ${url}: it uses Launch's automatic SSL (re-run setup to switch it to your certificate).`;
  }
  const stored = domain.customCertificateExpiresAt ? new Date(domain.customCertificateExpiresAt) : undefined;
  if (!opts.force && isCustom(domain) && stored && stored.getTime() >= cert.validTo.getTime() - SAME_CERT_MS) {
    return `up-to-date ${url}: Launch already has the certificate expiring ${day(stored)}.`;
  }

  logger.info(`Uploading the certificate expiring ${day(cert.validTo)} to ${url} (Launch has: ${day(stored)})...`);
  await client.uploadCertificate(domain, cert);

  // Wait until Launch reports the certificate as active. The list endpoint returns a live SSL status.
  const deadline = Date.now() + (opts.waitSeconds ?? 300) * 1000;
  for (let delay = 5_000; ; delay = Math.min(delay * 2, 30_000)) {
    const info = (await findDomain(client, url)).domainInfo;
    const ssl = info?.sslStatus?.toLowerCase();
    if (ssl === 'active') {
      if (info?.status && info.status.toLowerCase() !== 'active') {
        logger.warn(`${url} has the new certificate, but the domain itself is not live yet (${info.domainStatusDescription ?? info.status}). Finish its DNS setup in Launch → Domains.`);
      }
      break;
    }
    if (!ssl) {
      logger.warn(`Launch did not report an SSL status for ${url}; skipping the wait.`);
      break;
    }
    if (/fail|error|timed_out|expired/.test(ssl)) throw new VerificationError(`Launch reports SSL status "${ssl}" for ${url}.`);
    if (Date.now() + delay > deadline) {
      throw new VerificationError(`SSL for ${url} is still "${ssl}" after waiting.`, 'The certificate was uploaded; check again later with: sudo launch-cert-rotate status');
    }
    logger.info(`SSL status is "${ssl}"; checking again in ${delay / 1000}s...`);
    await sleep(delay);
  }

  // Read back what Launch stored.
  const after = await findDomain(client, url);
  const now = after.customCertificateExpiresAt ? new Date(after.customCertificateExpiresAt) : undefined;
  if (!isCustom(after) || !now || Math.abs(now.getTime() - cert.validTo.getTime()) > SAME_CERT_MS) {
    throw new VerificationError(`Launch does not show the new certificate for ${url} (stored expiry: ${day(now)}, uploaded: ${day(cert.validTo)}).`);
  }
  return `uploaded ${url}: Launch now serves the certificate expiring ${day(cert.validTo)} (was ${day(stored)}).`;
}

/** One-line status of a domain, using a live check. */
export async function domainStatus(client: LaunchClient, url: string): Promise<string> {
  const domain = await findDomain(client, url);
  const info = domain.domainInfo;
  const expires = domain.customCertificateExpiresAt;
  const days = expires ? Math.floor((new Date(expires).getTime() - Date.now()) / 86_400_000) : undefined;
  const lines = [
    `${url}: ${domain.sslMethod ?? 'unknown'} SSL, certificate ${expires ? `expires ${day(expires)} (${days} days)` : 'managed by Launch'}, SSL status ${info?.sslStatus ?? 'unknown'}`,
  ];
  if (info?.status && info.status.toLowerCase() !== 'active') {
    lines.push(`  domain not live yet: ${info.domainStatusDescription ?? info.status}`);
  }
  return lines.join('\n');
}
