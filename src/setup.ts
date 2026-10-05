import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authHook, cleanupHook, findCertbot, hasRenewableCertificate, installSchedule, type Runner } from './certbot.js';
import { KEYS, loadConfig, paths, readConfigFile, writeConfigFile, type Env } from './config.js';
import { ValidationError } from './errors.js';
import { checkHostingerToken, zoneOf } from './hostinger.js';
import { LaunchClient, type FetchLike } from './launchClient.js';
import type { Logger } from './logger.js';
import type { Prompter } from './prompt.js';
import { uploadIfNewer } from './rotate.js';

export interface SetupDeps {
  env: Env;
  prompt: Prompter;
  out: (line: string) => void;
  logger: Logger;
  run: Runner;
  isRoot: boolean;
  /** Assume "yes" to confirmations (non-interactive setup). */
  yes: boolean;
  fetch?: FetchLike;
}

/**
 * `launch-cert-rotate setup`: asks for the Launch and Hostinger details, gets the certificate with certbot,
 * uploads it to Launch and schedules renewal. Safe to re-run: saved answers become the defaults.
 */
export async function setup(deps: SetupDeps): Promise<void> {
  const { env, prompt, out, logger, run } = deps;
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const step = (n: number, title: string) => {
    out(`\n[${n}/6] ${title}`);
  };
  const ok = (msg: string) => {
    out(`  ✓ ${msg}`);
  };

  step(1, 'Checking prerequisites');
  if (!deps.isRoot) throw new ValidationError('Setup must run as root.', 'Run: sudo launch-cert-rotate setup');
  const certbot = findCertbot();
  if (!certbot) {
    throw new ValidationError('certbot is not installed.', process.platform === 'darwin' ? 'Install it: brew install certbot' : 'Install it: sudo snap install --classic certbot');
  }
  ok(`certbot found: ${certbot}`);

  // Saved answers (from a previous run) and environment variables are the defaults.
  const values: Env = { ...readConfigFile(env) };
  const current = (key: string) => env[key] ?? values[key];

  step(2, 'Connecting to Launch');
  values[KEYS.host] = await prompt.ask('Launch API host', { default: current(KEYS.host) ?? 'https://launch-api.contentstack.com' });
  values[KEYS.authtoken] = await prompt.ask('Authtoken of the Contentstack user that manages the domain (hidden)', { secret: true, default: current(KEYS.authtoken) });
  logger.addSecret(values[KEYS.authtoken]);
  values[KEYS.orgUid] = await prompt.ask('Organization UID', { default: current(KEYS.orgUid) });
  values[KEYS.projectUid] = await prompt.ask('Launch project UID', { default: current(KEYS.projectUid) });
  values[KEYS.environmentUid] = await prompt.ask('Launch environment UID', { default: current(KEYS.environmentUid) });
  const client = new LaunchClient(loadConfig({ ...env, ...values }), logger, fetchImpl);
  const domains = (await client.listDomains()).filter((d) => d.isCustomDomain !== false);
  if (domains.length === 0) throw new ValidationError('This Launch environment has no custom domains.', 'Add one in Launch → Settings → Domains first.');
  ok(`Connected. Custom domains: ${domains.map((d) => d.url).join(', ')}`);

  step(3, 'Choosing domains');
  domains.forEach((d, i) => {
    out(`    ${i + 1}) ${d.url} (${d.sslMethod ?? '?'} SSL)`);
  });
  let selected: string[] = [];
  await prompt.ask('Domains to secure (numbers or names, comma-separated)', {
    default: current(KEYS.domains),
    validate: (answer) => {
      selected = [];
      for (const part of answer.split(/[\s,]+/).filter(Boolean)) {
        const match = /^\d+$/.test(part) ? domains[Number(part) - 1] : domains.find((d) => d.url === part.toLowerCase());
        if (!match) return `"${part}" is not in the list.`;
        if (!selected.includes(match.url)) selected.push(match.url);
      }
      return selected.length ? undefined : 'Pick at least one domain.';
    },
  });
  values[KEYS.domains] = selected.join(',');
  ok(`Domains: ${selected.join(', ')}`);

  step(4, 'Hostinger DNS');
  out('    certbot proves you own the domain with a temporary DNS record, created through the Hostinger API.');
  out('    Create a token in hPanel → Profile → API.');
  for (;;) {
    const token = await prompt.ask('Hostinger API token (hidden)', { secret: true, default: current(KEYS.hostingerToken) });
    logger.addSecret(token);
    try {
      for (const zone of new Set(selected.map((d) => zoneOf(d, env)))) await checkHostingerToken(token, zone, fetchImpl);
      values[KEYS.hostingerToken] = token;
      ok('Hostinger token works');
      break;
    } catch (err) {
      if (!prompt.interactive) throw err;
      out(`    ${(err as Error).message}`);
    }
  }
  values[KEYS.email] = await prompt.ask("Email for Let's Encrypt notices (optional)", { default: current(KEYS.email), optional: true });
  writeConfigFile(env, values);
  ok(`Saved settings to ${paths(env).configFile}`);

  step(5, 'Getting the certificate and uploading it to Launch');
  const { letsencryptDir } = paths(env);
  const name = selected[0] as string;
  if (hasRenewableCertificate(letsencryptDir, name, selected)) {
    ok(`Using the existing certificate "${name}"`);
  } else {
    const email = values[KEYS.email];
    const args = [
      'certonly', '--non-interactive', '--agree-tos',
      ...(email ? ['--email', email, '--no-eff-email'] : ['--register-unsafely-without-email']),
      '--cert-name', name, ...selected.flatMap((d) => ['-d', d]),
      '--manual', '--preferred-challenges', 'dns',
      '--manual-auth-hook', authHook, '--manual-cleanup-hook', cleanupHook,
      // An existing certificate was made another way (e.g. by hand); replace it so renewals work unattended.
      ...(existsSync(join(letsencryptDir, 'live', name)) ? ['--force-renewal', '--expand'] : []),
    ];
    if (run(certbot, args) !== 0) {
      throw new ValidationError('certbot could not get the certificate (see its output above).', 'Details: /var/log/letsencrypt/letsencrypt.log');
    }
    ok(`Certificate saved in ${letsencryptDir}/live/${name}/`);
  }
  const live = join(letsencryptDir, 'live', name);
  for (const url of selected) {
    const domain = domains.find((d) => d.url === url);
    let switchFromAutomatic = false;
    if (domain?.sslMethod?.toUpperCase() !== 'CUSTOM') {
      switchFromAutomatic = deps.yes || (await prompt.confirm(`${url} uses Launch's automatic SSL. Switch it to your certificate?`, false));
    }
    ok(await uploadIfNewer(client, url, join(live, 'fullchain.pem'), join(live, 'privkey.pem'), { switchFromAutomatic }, logger));
  }

  step(6, 'Scheduling automatic renewal');
  ok(`Installed ${installSchedule(run)}: runs \`launch-cert-rotate renew\` twice a day`);

  out('\nDone. Check any time with:  sudo launch-cert-rotate status');
}
