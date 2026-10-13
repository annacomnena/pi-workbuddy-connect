// Upstream base addresses and the region rule.
//
// These are observations of a private, non-public interface (see docs/protocol.md).
// The region is derived from the login domain stored in the credential, never
// from configuration — feeding a CN credential to the global base is a hard
// error, not something to paper over.

export const CN_CHAT_BASE = 'https://copilot.tencent.com';
export const CN_BILLING_BASE = 'https://www.codebuddy.cn';
export const GLOBAL_BASE = 'https://www.workbuddy.ai';

/** The only hosts this tool is ever allowed to send credentials to. */
export const UPSTREAM_HOSTS = Object.freeze([
  'copilot.tencent.com',
  'www.codebuddy.cn',
  'www.workbuddy.ai',
]);

/** The region a login domain belongs to. Empty/unknown reads as `cn`. */
export function regionOfDomain(domain) {
  const lowered = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global';
  return 'cn';
}

function regionOfCredential(credential) {
  return regionOfDomain(credential?.domain);
}

export function chatBaseFor(credential) {
  return regionOfCredential(credential) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE;
}

export function billingBaseFor(credential) {
  return regionOfCredential(credential) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE;
}

/** Region-appropriate Origin/Referer value for browser-shaped headers. */
export function originFor(credential) {
  return regionOfCredential(credential) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE;
}

/**
 * Build an absolute URL for a path and assert the host is on the allow-list.
 * A programming error here must fail before a request leaves the process.
 */
export function upstreamUrl(base, path) {
  const url = new URL(path, base);
  if (!UPSTREAM_HOSTS.includes(url.hostname)) {
    throw new Error(`refusing to contact a non-upstream host: ${url.hostname}`);
  }
  return url;
}
