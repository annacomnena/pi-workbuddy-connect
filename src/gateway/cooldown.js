// Per-model cooldowns (risk R4).
//
// The upstream rate-limits per model. This gateway never retries, never swaps
// identity and never re-sends a throttled request: when an answer is 429 (or a
// hard-credit 402) the model enters a cooldown, and requests for that model are
// refused immediately with the remaining `Retry-After`. Other models keep
// working. The cooldown is visible on `/healthz` and in the error body, so a
// client can back off instead of guessing.

/** Assumed cooldown when the upstream gives no hint. */
export const DEFAULT_COOLDOWN_SECONDS = 60;
/** The observed upstream ceiling for a per-model cooldown (2 hours). */
export const MAX_COOLDOWN_SECONDS = 7200;

/** Clamp a hint into the allowed window. */
export function clampCooldown(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_COOLDOWN_SECONDS;
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(1, Math.ceil(seconds)));
}

/**
 * Parse a wall-clock hint from an upstream body.
 *
 * Observed 429 answers carry a per-model cooldown as a UTC+8 wall-clock time.
 * Zone-less strings are therefore read as UTC+8; anything unparsable is ignored
 * rather than guessed at.
 */
export function parseCooldownTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(raw)) {
    return Date.parse(`${raw.replace(' ', 'T')}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(raw)) return Date.parse(`${raw}+08:00`);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const HINT_KEY = /(cool|cooldown|retry|expire|reset|until)/iu;

/** Search a parsed body for a cooldown timestamp; undefined when absent. */
export function cooldownUntilFromBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(String(body ?? ''));
  } catch {
    return undefined;
  }
  const queue = [parsed];
  const seen = new Set();
  while (queue.length > 0) {
    const node = queue.shift();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && HINT_KEY.test(key)) {
        const at = parseCooldownTime(value);
        if (at !== undefined) return at;
      } else if (typeof value === 'object' && value !== null) {
        queue.push(value);
      }
    }
  }
  return undefined;
}

/**
 * The cooldown a failed answer implies.
 * Precedence: `Retry-After` header, then a timestamp in the body, then a default.
 */
export function cooldownSecondsFrom({ retryAfterSeconds, body, now = Date.now() }) {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return clampCooldown(retryAfterSeconds);
  }
  const until = cooldownUntilFromBody(body);
  if (until !== undefined) return clampCooldown(Math.round((until - now) / 1000));
  return DEFAULT_COOLDOWN_SECONDS;
}

/** The per-model cooldown table for one gateway process. */
export class ModelCooldowns {
  #until = new Map();

  /**
   * @param {{ defaultSeconds?: number, now?: () => number }} [options]
   */
  constructor({ defaultSeconds = DEFAULT_COOLDOWN_SECONDS, now = Date.now } = {}) {
    this.defaultSeconds = defaultSeconds;
    this.now = now;
  }

  /** Enter (or extend) a cooldown for a model. */
  penalize(model, seconds = this.defaultSeconds, at = this.now()) {
    const key = String(model ?? '');
    if (key === '') return { retryAfterSeconds: 0, until: undefined };
    const bounded = clampCooldown(seconds);
    const until = at + bounded * 1000;
    const currentUntil = this.#until.get(key);
    if (currentUntil === undefined || until > currentUntil) this.#until.set(key, until);
    return { retryAfterSeconds: bounded, until: new Date(this.#until.get(key)).toISOString() };
  }

  /** Whether a model is cooling right now. */
  status(model, at = this.now()) {
    const until = this.#until.get(String(model ?? ''));
    if (until === undefined) return { cooling: false, retryAfterSeconds: 0 };
    const remaining = Math.ceil((until - at) / 1000);
    if (remaining <= 0) {
      this.#until.delete(String(model ?? ''));
      return { cooling: false, retryAfterSeconds: 0 };
    }
    return { cooling: true, retryAfterSeconds: remaining, until: new Date(until).toISOString() };
  }

  /** Force an immediate end of a model's cooldown. */
  clear(model) {
    this.#until.delete(String(model ?? ''));
  }

  /** Every active cooldown, for `/healthz`. */
  snapshot(at = this.now()) {
    const active = {};
    for (const model of [...this.#until.keys()]) {
      const status = this.status(model, at);
      if (status.cooling) active[model] = status.retryAfterSeconds;
    }
    return active;
  }
}
