/**
 * Logging with redaction: tokens and private keys never reach the output, even with --debug.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const REDACTED = '[REDACTED]';

/** Keys whose values are always hidden, at any depth. */
const SECRET_KEYS = /^(authtoken|authorization|customprivatekey|privatekey|password|token|cookie)$/i;
const PEM = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----\r?\n?|$)/g;

/** Hide PEM bodies, bearer tokens and the given secret values inside a string. */
export function redactString(input: string, secrets: Iterable<string> = []): string {
  let out = input;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join(REDACTED);
  return out
    .replace(PEM, (block, type: string) =>
      type.includes('PRIVATE KEY') ? `[REDACTED ${type}]` : `[${type} PEM, ${Buffer.byteLength(block)} bytes]`,
    )
    .replace(/\b(Bearer)\s+\S+/gi, `$1 ${REDACTED}`);
}

/** Deep-copy a value with secrets hidden. */
export function redact(value: unknown, secrets: Iterable<string> = []): unknown {
  const list = [...secrets];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v, list);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v).map(([k, inner]) => [k, SECRET_KEYS.test(k) && inner ? REDACTED : walk(inner)]),
      );
    }
    return v;
  };
  return walk(value);
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string): void;
  warn(message: string): void;
  /** Register a value (token, key) that must never be printed. */
  addSecret(secret: string | undefined): void;
  redact(value: unknown): unknown;
  redactString(value: string): string;
}

export function createLogger(opts: { level?: LogLevel; write?: (line: string) => void } = {}): Logger {
  const level = opts.level ?? 'info';
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const secrets = new Set<string>();
  const emit = (lvl: LogLevel, message: string, data?: unknown): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const prefix = lvl === 'info' ? '' : `${lvl.toUpperCase()}: `;
    const extra = data === undefined ? '' : `\n${JSON.stringify(redact(data, secrets), null, 2)}`;
    write(`${prefix}${redactString(message, secrets)}${extra}`);
  };
  return {
    debug: (m, d) => {
      emit('debug', m, d);
    },
    info: (m) => {
      emit('info', m);
    },
    warn: (m) => {
      emit('warn', m);
    },
    addSecret: (s) => {
      if (s) secrets.add(s.trim());
    },
    redact: (v) => redact(v, secrets),
    redactString: (v) => redactString(v, secrets),
  };
}

export const silentLogger: Logger = createLogger({ write: () => undefined });
