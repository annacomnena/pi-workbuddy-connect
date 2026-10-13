// A last-line leak scanner.
//
// Masking is applied by construction, but the CLI also scans its own rendered
// output before printing it: if a rendered document still contains a token
// shape, or an exact secret this process holds, the command fails closed
// instead of printing it. This is the "token redaction self-check" the status
// output reports.

/** Token-ish patterns that must never appear in a rendered document. */
export const LEAK_PATTERNS = Object.freeze([
  { id: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu },
  { id: 'bearer-header', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu },
  { id: 'refresh-header', regex: /\bX-Refresh-Token\b\s*[:=]\s*\S{8,}/giu },
  { id: 'encrypted-envelope', regex: /"\$wbEncrypted"\s*:\s*1/u },
  { id: 'envelope-ciphertext', regex: /"ciphertext"\s*:\s*"/u },
  { id: 'base64-blob', regex: /[A-Za-z0-9+/]{80,}={0,2}/gu },
]);

/** A 4-char preview of a match, so a report can point at the shape. */
function preview(sample) {
  return sample.length <= 8 ? sample : `${sample.slice(0, 4)}\u2026`;
}

/**
 * Scan a rendered document for leak shapes.
 *
 * @param {string} text
 * @param {string[]} [secrets] exact secret values held by this process; an
 *   occurrence of any of them is a leak regardless of shape.
 * @returns {{ pattern: string, preview: string }[]}
 */
export function findLeaks(text, secrets = []) {
  const source = typeof text === 'string' ? text : '';
  const hits = [];
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '' && source.includes(secret)) {
      hits.push({ pattern: 'known-secret', preview: preview(secret) });
    }
  }
  for (const { id, regex } of LEAK_PATTERNS) {
    const matches = source.match(regex);
    if (matches && matches.length > 0) {
      hits.push({ pattern: id, preview: preview(matches[0]) });
    }
  }
  return hits;
}

/** Convenience boolean form of {@link findLeaks}. */
export function isClean(text, secrets = []) {
  return findLeaks(text, secrets).length === 0;
}
