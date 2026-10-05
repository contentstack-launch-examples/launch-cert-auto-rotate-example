import type { Config } from './config.js';
import { ApiError, AppError, ExitCode, parseErrorBody } from './errors.js';
import { silentLogger, type Logger } from './logger.js';

/** A Launch domain, as returned by the list endpoint. */
export interface LaunchDomain {
  uid: string;
  url: string;
  isCustomDomain?: boolean;
  sslMethod?: string | null;
  customCertificateExpiresAt?: string | null;
  domainInfo?: { status?: string; domainStatusDescription?: string; sslStatus?: string } | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Client for the Launch domains API: …/projects/{project}/environments/{env}/domains */
export class LaunchClient {
  private readonly base: string;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger = silentLogger,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.base = `${config.host}/projects/${encodeURIComponent(config.projectUid)}/environments/${encodeURIComponent(config.environmentUid)}/domains`;
    logger.addSecret(config.authtoken);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authtoken: this.config.authtoken,
      organization_uid: this.config.orgUid,
      // Required: Launch reads the project from this header for its permission checks.
      'x-project-uid': this.config.projectUid,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    this.logger.debug(`→ ${method} ${path}`, body === undefined ? { headers } : { headers, body });

    // GET and revalidate are safe to retry on network errors and 429/5xx; uploads are sent once.
    const attempts = method === 'PUT' ? 1 : 3;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new AppError(`${method} ${path} failed: ${(err as Error).message}`, ExitCode.API_ERROR, 'Check LAUNCH_HOST and your network.');
      }
      const text = await res.text();
      this.logger.debug(`← ${res.status} ${method} ${path}`, text ? safeJson(text) : undefined);
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(1000 * attempt);
        continue;
      }
      const { code, message } = parseErrorBody(text);
      throw new ApiError(res.status, code, message && this.logger.redactString(message), `${method} ${path}`);
    }
  }

  /** All domains in the environment (the API returns at most 100 per page). */
  async listDomains(): Promise<LaunchDomain[]> {
    const all: LaunchDomain[] = [];
    for (let skip = 0; ; skip += 100) {
      const page = await this.request<{ domains?: LaunchDomain[] }>('GET', `?limit=100&skip=${skip}`);
      const domains = page.domains ?? [];
      all.push(...domains);
      if (domains.length < 100 || skip > 10_000) return all;
    }
  }

  async findDomain(url: string): Promise<LaunchDomain | undefined> {
    const wanted = url.toLowerCase();
    return (await this.listDomains()).find((d) => d.url.toLowerCase() === wanted);
  }

  /** Upload a certificate. The domain's existing url is sent unchanged: changing it would rename the domain. */
  async uploadCertificate(domain: LaunchDomain, cert: { leaf: string; chain: string; key: string }): Promise<void> {
    this.logger.addSecret(cert.key);
    await this.request('PUT', `/${encodeURIComponent(domain.uid)}`, {
      url: domain.url,
      sslMethod: 'CUSTOM', // without it Launch silently ignores the certificate
      customCertificate: cert.leaf,
      customPrivateKey: cert.key,
      ...(cert.chain ? { intermediateCertificates: cert.chain } : {}),
    });
  }

  /** Ask Launch to re-check DNS/SSL now; returns the fresh domainInfo. */
  async revalidate(domain: LaunchDomain): Promise<LaunchDomain['domainInfo']> {
    const res = await this.request<{ domainInfo?: LaunchDomain['domainInfo'] }>('POST', `/${encodeURIComponent(domain.uid)}/revalidate`);
    return res?.domainInfo ?? null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}
