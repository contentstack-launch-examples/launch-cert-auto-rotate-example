import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** certbot and scheduling helpers. */

export type Runner = (cmd: string, args: string[]) => number;

/** Runs a command with its output shown in the terminal. */
export const runCommand: Runner = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  return res.error ? 127 : (res.status ?? 1);
};

export function findCertbot(): string | undefined {
  const onPath = spawnSync('sh', ['-c', 'command -v certbot'], { encoding: 'utf8' }).stdout.trim();
  return [onPath, '/usr/bin/certbot', '/usr/local/bin/certbot', '/snap/bin/certbot', '/opt/homebrew/bin/certbot'].find(
    (p) => p && existsSync(p),
  );
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** This installation of the CLI, run by this Node binary (independent of root's PATH). */
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
export const selfCommand = (...args: string[]) => [quote(process.execPath), quote(cliPath), ...args].join(' ');

/** Hook command lines stored by certbot for renewals. */
export const authHook = selfCommand('hostinger-hook', 'auth');
export const cleanupHook = selfCommand('hostinger-hook', 'cleanup');

/** Does /etc/letsencrypt/live/<name>/ hold a certificate for all `domains` that renews with our Hostinger hook? */
export function hasRenewableCertificate(letsencryptDir: string, name: string, domains: string[]): boolean {
  try {
    const cert = new X509Certificate(readFileSync(join(letsencryptDir, 'live', name, 'fullchain.pem')));
    const conf = readFileSync(join(letsencryptDir, 'renewal', `${name}.conf`), 'utf8');
    return domains.every((d) => cert.checkHost(d) !== undefined) && conf.includes('hostinger-hook auth');
  } catch {
    return false;
  }
}

const LABEL = 'com.contentstack.launch-cert-rotate';
const LOG = '/var/log/launch-cert-rotate.log';

/** Run `launch-cert-rotate renew` twice a day as root. certbot only renews when a certificate is due. */
export function installSchedule(run: Runner): string {
  if (process.platform === 'darwin') {
    const plist = `/Library/LaunchDaemons/${LABEL}.plist`;
    const times = [3, 15].map((h) => `<dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>17</integer></dict>`);
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cliPath}</string><string>renew</string><string>--quiet</string></array>
  <key>StartCalendarInterval</key><array>${times.join('')}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>${LOG}</string><key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`,
      { mode: 0o644 },
    );
    spawnSync('launchctl', ['bootout', `system/${LABEL}`], { stdio: 'ignore' }); // unload an older copy, if any
    run('launchctl', ['bootstrap', 'system', plist]);
    return `launchd job ${plist}`;
  }
  if (!existsSync('/etc/cron.d')) return 'nothing: no /etc/cron.d here. Run `sudo launch-cert-rotate renew` daily from your scheduler';
  const cron = '/etc/cron.d/launch-cert-rotate';
  writeFileSync(
    cron,
    `# Installed by launch-cert-rotate setup\n17 3,15 * * * root ${selfCommand('renew', '--quiet')} >> ${LOG} 2>&1\n`,
    { mode: 0o644 },
  );
  return `cron job ${cron}`;
}
