#!/usr/bin/env node
import { join } from 'node:path';
import { Command } from 'commander';
import { findCertbot, runCommand } from './certbot.js';
import { loadConfig, paths } from './config.js';
import { AppError, ExitCode, ValidationError } from './errors.js';
import { hostingerHook } from './hostinger.js';
import { LaunchClient } from './launchClient.js';
import { createLogger, type Logger } from './logger.js';
import { createPrompter } from './prompt.js';
import { domainStatus, uploadIfNewer } from './rotate.js';
import { setup } from './setup.js';

const isRoot = process.getuid?.() === 0;
const print = (line: string) => process.stdout.write(`${line}\n`);
const printErr = (line: string) => process.stderr.write(`${line}\n`);

/** Run a command, print errors (with secrets redacted) and set the exit code. */
const action =
  <A extends unknown[]>(fn: (logger: Logger, ...args: A) => Promise<number | undefined>) =>
  async (...args: A): Promise<void> => {
    const opts = program.opts<{ debug?: boolean }>();
    const logger = createLogger({ level: opts.debug ? 'debug' : 'info', write: printErr });
    try {
      process.exitCode = (await fn(logger, ...args)) ?? ExitCode.OK;
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError(err instanceof Error ? err.message : String(err));
      printErr(`Error: ${logger.redactString(e.message)}`);
      if (e.hint) printErr(`Hint: ${e.hint}`);
      process.exitCode = e.exitCode;
    }
  };

const program = new Command()
  .name('launch-cert-rotate')
  .description(
    "Keep a Let's Encrypt certificate (certbot + Hostinger DNS) on a Contentstack Launch domain up to date.\n\n" +
      '  sudo launch-cert-rotate setup    one-time setup\n' +
      '  sudo launch-cert-rotate renew    renew when due, then upload (scheduled)\n' +
      '  sudo launch-cert-rotate status   show certificate status',
  )
  .option('--debug', 'show every API request and response (secrets are hidden)');

program
  .command('setup')
  .description('one-time guided setup')
  .option('--yes', 'non-interactive: take answers from environment variables and saved settings')
  .action(
    action(async (logger, opts: { yes?: boolean }) => {
      const prompt = createPrompter({
        // isTTY is undefined (not false) when stdin is a pipe.
        interactive: !opts.yes && process.stdin.isTTY,
        write: (s) => process.stderr.write(s),
      });
      try {
        await setup({ env: process.env, prompt, out: printErr, logger, run: runCommand, isRoot, yes: !!opts.yes });
      } finally {
        prompt.close();
      }
      return ExitCode.OK;
    }),
  );

program
  .command('renew')
  .description('renew the certificate with certbot when due, then make sure Launch has the latest one')
  .option('--dry-run', "test renewal against Let's Encrypt's staging server; changes nothing")
  .option('--force', 'renew now even if not due')
  .option('--quiet', 'only print problems (used by the schedule)')
  .action(
    action(async (logger, opts: { dryRun?: boolean; force?: boolean; quiet?: boolean }) => {
      if (!isRoot) throw new ValidationError('renew must run as root.', 'Run: sudo launch-cert-rotate renew');
      const config = loadConfig(process.env);
      const name = config.domains[0];
      const certbot = findCertbot();
      if (!name) throw new ValidationError('No domains configured.', 'Run: sudo launch-cert-rotate setup');
      if (!certbot) throw new ValidationError('certbot is not installed.');

      const args = ['renew', '--cert-name', name];
      if (opts.dryRun) args.push('--dry-run');
      if (opts.force) args.push('--force-renewal');
      if (opts.quiet) args.push('--quiet');
      if (runCommand(certbot, args) !== 0) {
        throw new ValidationError('certbot could not renew the certificate.', 'Details: /var/log/letsencrypt/letsencrypt.log');
      }
      if (opts.dryRun) {
        print('Dry run OK: renewal works. Nothing was changed.');
        return ExitCode.OK;
      }

      // Upload what is on disk. A no-op when Launch is up to date; also repairs a missed upload.
      const client = new LaunchClient(config, logger);
      const live = join(paths(process.env).letsencryptDir, 'live', name);
      let exitCode: number = ExitCode.OK;
      for (const url of config.domains) {
        try {
          const summary = await uploadIfNewer(client, url, join(live, 'fullchain.pem'), join(live, 'privkey.pem'), {}, logger);
          if (!opts.quiet || !summary.startsWith('up-to-date')) print(summary);
        } catch (err) {
          const e = err instanceof AppError ? err : new AppError(String(err));
          printErr(`Error (${url}): ${logger.redactString(e.message)}${e.hint ? `\nHint: ${e.hint}` : ''}`);
          exitCode = Math.max(exitCode, e.exitCode);
        }
      }
      return exitCode;
    }),
  );

program
  .command('status')
  .description('show the certificate status of the configured domains')
  .action(
    action(async (logger) => {
      const config = loadConfig(process.env);
      if (config.domains.length === 0) throw new ValidationError('No domains configured.', 'Run: sudo launch-cert-rotate setup');
      const client = new LaunchClient(config, logger);
      for (const url of config.domains) print(await domainStatus(client, url));
      return ExitCode.OK;
    }),
  );

// Called by certbot during issuance/renewal (see src/hostinger.ts); not meant to be run by hand.
program
  .command('hostinger-hook <mode>', { hidden: true })
  .action(
    action(async (_logger, mode: string) => {
      await hostingerHook(mode, process.env, printErr);
      return ExitCode.OK;
    }),
  );

await program.parseAsync();
