import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ValidationError } from './errors.js';

/** Launch's size limit for each PEM field. */
const MAX_FIELD_BYTES = 32 * 1024;

export interface Certificate {
  /** Leaf certificate PEM → customCertificate. */
  leaf: string;
  /** Intermediate certificate PEMs → intermediateCertificates ('' if none). */
  chain: string;
  /** Private key PEM → customPrivateKey. Never log this. */
  key: string;
  validTo: Date;
  names: string[];
}

const pemBlocks = (text: string, type: RegExp): string[] =>
  [...text.replace(/\r\n/g, '\n').matchAll(/-----BEGIN ([A-Z ]+)-----\n[\s\S]*?-----END \1-----/g)]
    .filter((m) => type.test(m[1] ?? ''))
    .map((m) => `${m[0]}\n`);

const commonName = (dn: string) => /CN=([^\n]+)/.exec(dn)?.[1] ?? dn;

/**
 * Read certbot's fullchain.pem + privkey.pem and check them before anything is uploaded:
 * key matches, certificate is currently valid, covers the domain, and the chain is in order.
 * Launch validates again on upload; these checks catch a wrong file early and explain why.
 */
export function loadCertificate(certPath: string, keyPath: string, domain: string, now = new Date()): Certificate {
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      throw new ValidationError(`Cannot read ${path}.`, 'Run with sudo; certbot files are root-only.');
    }
  };
  const [leafPem, ...chainPems] = pemBlocks(read(certPath), /^CERTIFICATE$/);
  const [keyPem] = pemBlocks(read(keyPath), /PRIVATE KEY$/);
  if (!leafPem) throw new ValidationError(`No certificate found in ${certPath}.`);
  if (!keyPem) throw new ValidationError(`No private key found in ${keyPath}.`);
  if (keyPem.includes('ENCRYPTED')) throw new ValidationError('The private key is passphrase-protected; that is not supported.');

  const chain = chainPems.join('');
  for (const [field, value] of [['certificate', leafPem], ['chain', chain], ['private key', keyPem]] as const) {
    if (Buffer.byteLength(value) > MAX_FIELD_BYTES) throw new ValidationError(`The ${field} is larger than Launch's 32 KiB limit.`);
  }

  const leaf = new X509Certificate(leafPem);
  if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new ValidationError('The private key does not match the certificate.', 'Use fullchain.pem and privkey.pem from the same certbot folder.');
  }
  const validFrom = new Date(leaf.validFrom);
  const validTo = new Date(leaf.validTo);
  if (now < validFrom) throw new ValidationError(`The certificate is not valid until ${validFrom.toISOString()}.`);
  if (now >= validTo) throw new ValidationError(`The certificate expired on ${validTo.toISOString()}.`, 'Renew it first.');

  const names = (leaf.subjectAltName ?? '').split(/,\s*/).filter((n) => n.startsWith('DNS:')).map((n) => n.slice(4));
  if (leaf.checkHost(domain) === undefined) {
    throw new ValidationError(`The certificate does not cover ${domain} (it covers: ${names.join(', ') || commonName(leaf.subject)}).`);
  }

  // Each certificate must be issued by the next one: leaf → intermediate(s).
  const certs = [leaf, ...chainPems.map((p) => new X509Certificate(p))];
  for (let i = 0; i + 1 < certs.length; i++) {
    const [child, parent] = [certs[i] as X509Certificate, certs[i + 1] as X509Certificate];
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      throw new ValidationError(
        `The certificate chain is out of order: "${commonName(child.subject)}" was not issued by "${commonName(parent.subject)}".`,
      );
    }
  }
  if (chainPems.length === 0) {
    throw new ValidationError(`${certPath} has no intermediate certificates.`, 'Use certbot\'s fullchain.pem, not cert.pem.');
  }

  return { leaf: leafPem, chain, key: keyPem, validTo, names };
}
