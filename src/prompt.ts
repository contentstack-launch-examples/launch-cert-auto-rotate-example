import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { ValidationError } from './errors.js';

export interface AskOptions {
  /** Shown in brackets and used when the answer is empty. */
  default?: string | undefined;
  /** Hide the typed characters (tokens). */
  secret?: boolean;
  /** Return an error message to re-ask, or undefined to accept. */
  validate?: (value: string) => string | undefined;
  /** Allow an empty answer when there is no default. */
  optional?: boolean;
}

export interface Prompter {
  readonly interactive: boolean;
  ask(question: string, opts?: AskOptions): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

/**
 * Interactive prompts on stderr. In non-interactive mode (`--yes`, or no TTY) every question takes its
 * default; a required question without one is an error, so automation fails loudly.
 */
export function createPrompter(opts: {
  interactive: boolean;
  write: (s: string) => void;
}): Prompter {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) opts.write(chunk.toString());
      cb();
    },
  });
  const rl = opts.interactive
    ? createInterface({ input: process.stdin, output, terminal: true })
    : undefined;

  const ask = async (question: string, o: AskOptions = {}): Promise<string> => {
    const hint = o.default
      ? o.secret
        ? ' [press Enter to keep the current one]'
        : ` [${o.default}]`
      : '';
    if (!rl) {
      const value = o.default ?? '';
      if (!value && !o.optional) {
        throw new ValidationError(
          `Missing value for: ${question}`,
          'Provide it via the environment, or run setup interactively.',
        );
      }
      const err = value && o.validate?.(value);
      if (err) throw new ValidationError(`${question}: ${err}`);
      return value;
    }
    for (;;) {
      // readline writes the prompt synchronously; muting right after hides only the typed secret.
      const pending = rl.question(`  ${question}${hint}: `);
      muted = !!o.secret;
      const answer = (await pending).trim();
      muted = false;
      if (o.secret) opts.write('\n');
      const value = answer || o.default || '';
      if (!value && !o.optional) {
        opts.write('    A value is required.\n');
        continue;
      }
      const err = value ? o.validate?.(value) : undefined;
      if (err) {
        opts.write(`    ${err}\n`);
        continue;
      }
      return value;
    }
  };

  return {
    interactive: !!rl,
    ask,
    async confirm(question, defaultYes) {
      if (!rl) return defaultYes;
      const answer = await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`, { optional: true });
      return answer ? /^y(es)?$/i.test(answer) : defaultYes;
    },
    close() {
      rl?.close();
    },
  };
}
