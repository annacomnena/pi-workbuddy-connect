// Error and reason-code vocabulary shared by every module.
//
// A reason code is part of the contract: `doctor` prints it, `status --json`
// carries it, and no code path is ever allowed to collapse a diagnosable
// failure into "not signed in". Missing, unreadable, and undecryptable
// credentials are distinct states.

export const REASON = Object.freeze({
  ok: 'ok',
  credentialMissing: 'credential-missing',
  credentialUnreadable: 'credential-unreadable',
  credentialUndecryptable: 'credential-undecryptable',
  electronNotFound: 'electron-not-found',
  electronDiscoveryIncomplete: 'electron-discovery-incomplete',
  credentialRegionMismatch: 'credential-region-mismatch',
  sessionDead: 'session-dead',
  creditExhausted: 'credit-exhausted',
  rateLimited: 'rate-limited',
  billingUnreachable: 'billing-unreachable',
  catalogUnreachable: 'catalog-unreachable',
  upstreamUnreachable: 'upstream-unreachable',
  networkDisabled: 'network-disabled',
  upstreamClientError: 'upstream-client-error',
  upstreamServerError: 'upstream-server-error',
});

/** An error that always travels with a machine-readable reason code. */
export class WbError extends Error {
  /**
   * @param {string} code one of {@link REASON}
   * @param {string} message human-readable, must not contain credential values
   * @param {{ cause?: unknown, detail?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WbError';
    this.code = code;
    this.detail = options.detail ?? {};
  }
}

/** The reason code of an arbitrary thrown value, or undefined. */
export function reasonCodeOf(error) {
  return error instanceof WbError ? error.code : undefined;
}

/** A one-line, value-free description of an arbitrary thrown value. */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
