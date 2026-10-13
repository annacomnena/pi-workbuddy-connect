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
  sessionRefreshFailed: 'session-refresh-failed',
  creditExhausted: 'credit-exhausted',
  rateLimited: 'rate-limited',
  billingUnreachable: 'billing-unreachable',
  catalogUnreachable: 'catalog-unreachable',
  upstreamUnreachable: 'upstream-unreachable',
  networkDisabled: 'network-disabled',
  upstreamClientError: 'upstream-client-error',
  upstreamServerError: 'upstream-server-error',
  // Gateway (S1) states. The gateway never collapses a diagnosable failure into
  // a generic "bad request": each one maps to a distinct HTTP status and to a
  // distinct OpenAI error `type`.
  invalidRequest: 'invalid-request',
  gatewayForbidden: 'gateway-forbidden',
  gatewayUnauthorized: 'gateway-unauthorized',
  gatewayCooling: 'gateway-cooling',
  gatewayTokenUnavailable: 'gateway-token-unavailable',
  ownCopyUnprotected: 'own-copy-unprotected',
  // models.json (S2) states. Installing a provider must never fail in a way that
  // leaves the user's own model list in doubt, so an unreadable or non-plain-JSON
  // file is reported by name instead of being overwritten.
  modelsJsonUnreadable: 'models-json-unreadable',
  // models.json changed between the read and the write (S2.1, SF-2): fail closed
  // instead of clobbering an edit made by another process in that window.
  modelsJsonChanged: 'models-json-changed',
  // Model-exposure policy (S2.1). `models` config lives in gateway.json; an
  // unreadable policy is reported by name, and a request for a model the policy
  // hides is a 404 `model_not_found` carrying this reason code.
  modelsConfigUnreadable: 'models-config-unreadable',
  // gateway.json changed between the read and the write (S2.1, S-5): the same
  // fail-closed guard models.json has (SF-2), so a concurrent `models set` and a
  // hand edit cannot silently lose one of the two updates.
  gatewayConfigChanged: 'gateway-config-changed',
  modelUnknown: 'model-unknown',
  modelNotExposed: 'model-not-exposed',
  // The requested gateway port was taken and the caller asked for it explicitly
  // (`--port`), so no fallback is allowed.
  portUnavailable: 'port-unavailable',
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
