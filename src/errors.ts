/** Process exit codes. */
export const ExitCode = {
  OK: 0,
  /** Bad input or configuration. Nothing was uploaded. */
  USER_ERROR: 1,
  /** The Launch API returned an error or could not be reached. */
  API_ERROR: 2,
  /** The upload was sent but could not be confirmed. */
  VERIFICATION_FAILED: 3,
} as const;

/** An expected failure with a message that is safe to show (never contains secrets). */
export class AppError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = ExitCode.USER_ERROR,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.USER_ERROR, hint);
  }
}

export class VerificationError extends AppError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.VERIFICATION_FAILED, hint);
  }
}

/** Launch error codes → fix hints. Codes arrive as `launch.DOMAINS.<CODE>`. */
const HINTS: Record<string, string> = {
  CUSTOM_SSL_NOT_ENABLED:
    'Custom certificates are not enabled for this Launch environment. Contact Contentstack support.',
  SSL_CERTIFICATE_CHAIN_INCOMPLETE: 'Launch needs the full chain: use fullchain.pem.',
  SSL_CERTIFICATE_KEY_MISMATCH: 'The private key does not belong to this certificate.',
  SSL_CERTIFICATE_EXPIRED: 'The certificate is expired; renew it first.',
};

const STATUS_HINTS: Record<number, string> = {
  401: 'Check LAUNCH_AUTHTOKEN (it may have expired); re-run setup to update it.',
  403: 'Check LAUNCH_ORG_UID / LAUNCH_PROJECT_UID and that the user can access this project.',
  404: 'Check LAUNCH_HOST, LAUNCH_PROJECT_UID and LAUNCH_ENVIRONMENT_UID.',
};

export class ApiError extends AppError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    detail: string | undefined,
    request: string,
  ) {
    const short = code?.replace(/^launch\.DOMAINS\./, '');
    super(
      `${request} failed with HTTP ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`,
      ExitCode.API_ERROR,
      (short && HINTS[short]) ?? STATUS_HINTS[status],
    );
  }
}

/** Pull `{ code, message }` out of an error response body, whatever its exact shape. */
export function parseErrorBody(text: string): { code?: string; message?: string } {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const code =
    str(body.error_code) ?? str(body.errorCode) ?? str(body.code) ?? /launch\.[A-Z_]+\.[A-Z0-9_]+/.exec(text)?.[0];
  const message =
    str(body.error_message) ?? str(body.message) ?? (Object.keys(body).length ? undefined : str(text.trim().slice(0, 200)));
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}
