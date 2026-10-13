// OpenAI chat body -> WorkBuddy upstream body.
//
// The upstream is *not* plain OpenAI-compatible. Four wire quirks are
// load-bearing (docs/protocol.md):
//
//   1. `stream` must be true — a non-streaming body is rejected.
//   2. `tool_choice` must be a string — the object forms return 400.
//   3. `role: "developer"` must be rewritten to `system` (400 / code 11128).
//   4. `reasoning_effort: "off"` must be dropped (400 on validating models).
//
// The international gateway additionally requires the first message to be a
// system message, so a missing one is prepended (never merged).
//
// Protocol facts derived from dsh-workbuddy-connect (MIT, (c) 2026 Corrine Hu);
// the code here is an independent re-expression. See THIRD-PARTY-NOTICES.md.

/** The prefix this gateway advertises in `/v1/models`; upstream never sees it. */
export const MODEL_PREFIX = 'workbuddy/';

/** The OpenAI model id a client sent, reduced to the upstream's own id. */
export function stripModelPrefix(id) {
  if (typeof id !== 'string') return '';
  const trimmed = id.trim();
  if (trimmed.toLowerCase().startsWith(MODEL_PREFIX)) return trimmed.slice(MODEL_PREFIX.length);
  return trimmed;
}

/** The OpenAI-compatible id this gateway advertises for an upstream model id. */
export function withModelPrefix(id) {
  return `${MODEL_PREFIX}${id}`;
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rewrite `role: "developer"` messages to `role: "system"` in place. */
export function normalizeDeveloperRole(body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (message.role === 'developer') message.role = 'system';
  }
  return body;
}

/**
 * Flatten `tool_choice` to the string spelling the upstream accepts.
 * `none` removes the tool declarations as well: the upstream has no native
 * "no tools" choice, and leaving `tools` with `tool_choice` deleted would
 * re-enable automatic tool use.
 */
export function normalizeToolChoice(body) {
  const suppressTools = () => {
    delete body.tools;
    delete body.functions;
  };
  if (!('tool_choice' in body)) return body;
  const choice = body.tool_choice;
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete body.tool_choice;
      suppressTools();
    }
    return body;
  }
  if (isObject(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';
    if (type === 'none') {
      delete body.tool_choice;
      suppressTools();
    } else if (type === 'auto' || type === 'required') {
      body.tool_choice = type;
    } else if (type === 'function') {
      const fn = isObject(choice.function) ? choice.function : undefined;
      let name = typeof fn?.name === 'string' ? fn.name : '';
      if (name === '' && typeof choice.name === 'string') name = choice.name;
      name = name.trim();
      body.tool_choice = name !== '' ? name : 'auto';
    } else {
      delete body.tool_choice;
    }
    return body;
  }
  delete body.tool_choice;
  return body;
}

/** Drop the adapter-only `reasoning_effort: "off"` spelling. */
export function dropUnsupportedEffort(body) {
  if (body.reasoning_effort === 'off') delete body.reasoning_effort;
  return body;
}

/** Minimal, content-free prompt used to satisfy the international precondition. */
export const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.';

/** Prepend a system message when the first message is not one (global only). */
export function ensureFirstSystem(body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const first = messages[0];
  if (isObject(first) && first.role === 'system') return body;
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT });
  return body;
}

/**
 * Validate an inbound OpenAI chat request.
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function parseChatRequest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'the request body is not valid JSON' };
  }
  if (!isObject(parsed)) return { ok: false, message: 'the request body must be a JSON object' };
  if (typeof parsed.model !== 'string' || parsed.model.trim() === '') {
    return { ok: false, message: '"model" is required and must be a non-empty string' };
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return { ok: false, message: '"messages" is required and must be a non-empty array' };
  }
  return { ok: true, value: parsed };
}

/**
 * Apply the wire quirks. `body.messages` and `body.tool_choice` are mutated
 * in place (the caller owns the parsed object); `stream` is always forced on.
 *
 * @param {object} body a valid request body (see {@link parseChatRequest})
 * @param {{ region?: 'cn'|'global' }} [options]
 * @returns {string} the upstream body
 */
export function prepareChatBody(body, { region = 'cn' } = {}) {
  body.model = stripModelPrefix(body.model);
  body.stream = true;
  normalizeDeveloperRole(body);
  normalizeToolChoice(body);
  dropUnsupportedEffort(body);
  if (region === 'global') ensureFirstSystem(body);
  return JSON.stringify(body);
}
