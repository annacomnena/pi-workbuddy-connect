// Byte-preserving edits to pi's `models.json`.
//
// pi reads models.json through a strict TypeBox schema (`dist/core/model-config.js`):
// `providers` is a record of provider configs whose keys, and whose models' keys, are
// all enumerated; `additionalProperties` is left unset (so it defaults to *closed*),
// and a single unknown key invalidates the WHOLE file -- every provider, not just ours.
// Two consequences shape this module:
//
//   1. We emit only keys pi accepts, and we check our own entry against that key set
//      before writing (`assertProviderEntryValid`).
//   2. We never re-serialize the file. The user's models.json is CRLF, indented with
//      two spaces, and mixes inline (`["text"]`) and expanded arrays -- it is not the
//      output of JSON.stringify(..., 2). Re-serializing would rewrite all ~291 lines.
//      Instead we splice exactly one member into the `providers` object, so every
//      other provider stays byte-identical.
//
// The scanner below is a small JSON reader that returns *offsets* rather than values:
// it understands strings (with escapes) and nested objects/arrays, which is what makes
// a safe splice possible in the face of braces and commas inside string values.

/** The provider key this project owns inside models.json. */
export const PROVIDER_KEY = 'workbuddy';

/** The pi API id the loopback gateway speaks. */
export const PROVIDER_API = 'openai-completions';

/** The gateway's historical model-id prefix; still accepted as an alias on the wire. */
export const LEGACY_MODEL_PREFIX = 'workbuddy/';

/**
 * Compatibility flags written for the gateway.
 *
 * Every one of these is a *verified* difference from a stock OpenAI endpoint (see
 * docs/protocol.md), not a guess based on the word "compatible":
 *
 *   supportsStore             the gateway forwards the body to a private upstream
 *                             that has no `store` field; omitting it keeps the
 *                             request to the documented surface.
 *   supportsDeveloperRole     the upstream rejects `role: "developer"`; the gateway
 *                             rewrites it, and not sending it at all is cheaper.
 *   supportsReasoningEffort   the upstream accepts low/medium/high/xhigh/max
 *                             (`reasoning_effort: "off"` is dropped by the gateway).
 *                             pi only sends effort for models marked `reasoning: true`.
 *   supportsUsageInStreaming  the upstream reports `usage` on its final stream chunk
 *                             on its own; `stream_options` was never observed to be
 *                             accepted.
 *   maxTokensField            the upstream takes `max_tokens`, not `max_completion_tokens`.
 */
export const PROVIDER_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: false,
  maxTokensField: 'max_tokens',
});

/** Every key pi's ProviderConfigSchema accepts. Anything else invalidates the file. */
const PROVIDER_KEYS = new Set(['name', 'baseUrl', 'apiKey', 'api', 'oauth', 'headers', 'compat', 'authHeader', 'models', 'modelOverrides']);

/** Every key pi's ModelDefinitionSchema accepts. */
const MODEL_KEYS = new Set(['id', 'name', 'api', 'baseUrl', 'reasoning', 'thinkingLevelMap', 'input', 'inputLimits', 'cost', 'promptCache', 'contextWindow', 'maxTokens', 'samplingParams', 'headers', 'compat']);

/** The openai-completions branch of pi's ProviderCompatSchema (the one we write). */
const COMPAT_KEYS = new Set([
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
  'supportsFinishReason', 'maxTokensField', 'requiresToolResultName', 'requiresAssistantAfterToolResult',
  'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
  'chatTemplateKwargs', 'chatTemplateArgs', 'cacheControlFormat', 'openRouterRouting', 'vercelGatewayRouting',
  'supportsOpenAIGrammarTools', 'supportsStrictMode', 'sendSessionAffinityHeaders', 'sessionAffinityFormat',
  'supportsLongCacheRetention', 'vllmPriority',
]);

const COST_KEYS = new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'tiers']);

/** Formatting used when the file does not exist yet. */
export const DEFAULT_FORMAT = Object.freeze({ newline: '\n', indentUnit: '  ' });

const BOM = '\uFEFF';

// ── scanner ─────────────────────────────────────────────────────────

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

export function stripBom(text) {
  return typeof text === 'string' && text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && isWhitespace(text[i])) i += 1;
  return i;
}

/** `text[index]` is `"`; returns the offset just past the closing quote. */
function skipString(text, index) {
  let i = index + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') { i += 2; continue; }
    if (char === '"') return i + 1;
    i += 1;
  }
  throw new Error('models.json has an unterminated string');
}

/**
 * `text[index]` starts a value; returns the offset just past it. Object and array
 * nesting is walked with string awareness, so a `}` inside a string value never
 * terminates the scan early.
 */
function skipValue(text, index) {
  const start = skipWhitespace(text, index);
  const char = text[start];
  if (char === '"') return skipString(text, start);
  if (char === '{' || char === '[') {
    const close = char === '{' ? '}' : ']';
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const current = text[i];
      if (current === '"') { i = skipString(text, i); continue; }
      if (current === char) depth += 1;
      else if (current === close) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new Error('models.json has an unbalanced object or array');
  }
  let i = start;
  while (i < text.length && !',}]'.includes(text[i])) i += 1;
  while (i > start && isWhitespace(text[i - 1])) i -= 1;
  return i;
}

/**
 * The direct members of the object whose `{` is at `objOpen`.
 * @returns {Array<{ key: string, keyStart: number, keyEnd: number, valueStart: number, valueEnd: number }>}
 */
export function listMembers(text, objOpen) {
  const members = [];
  let i = skipWhitespace(text, objOpen + 1);
  while (i < text.length) {
    const char = text[i];
    if (char === '}') break;
    if (char === ',') { i = skipWhitespace(text, i + 1); continue; }
    if (char !== '"') throw new Error(`models.json is not a plain JSON object (offset ${i})`);
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ':') throw new Error(`models.json is missing ":" after ${JSON.stringify(key)}`);
    const valueStart = skipWhitespace(text, i + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipWhitespace(text, valueEnd);
  }
  return members;
}

/**
 * Locate the root object and (when present) the `providers` object inside it.
 * All offsets are valid indices into the text that was passed in, BOM included.
 *
 * @returns {{ rootOpen: number, rootClose: number, rootMembers: object[],
 *   providersOpen?: number, providersClose?: number, providers?: object[] }}
 */
export function findProvidersObject(text) {
  const start = text.startsWith(BOM) ? BOM.length : 0;
  const rootOpen = skipWhitespace(text, start);
  if (text[rootOpen] !== '{') throw new Error('models.json must contain a JSON object at the top level');
  const rootMembers = listMembers(text, rootOpen);
  const rootClose = skipValue(text, rootOpen) - 1;
  const providersMember = rootMembers.find((member) => member.key === 'providers');
  if (providersMember === undefined) return { rootOpen, rootClose, rootMembers };
  if (text[providersMember.valueStart] !== '{') throw new Error('models.json has a "providers" that is not an object');
  return {
    rootOpen,
    rootClose,
    rootMembers,
    providersMember,
    providersOpen: providersMember.valueStart,
    providersClose: providersMember.valueEnd - 1,
    providers: listMembers(text, providersMember.valueStart),
  };
}

// ── formatting ──────────────────────────────────────────────────────

/** The indent unit of the file's first indented member, defaulting to two spaces. */
export function detectIndentUnit(text) {
  const match = /(?:^|\n)([ \t]+)"/u.exec(stripBom(text));
  return match === null ? DEFAULT_FORMAT.indentUnit : match[1];
}

/** The whitespace that precedes `index` on its line. */
export function lineIndentAt(text, index) {
  let start = index;
  while (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') start -= 1;
  return text.slice(start, index);
}

/**
 * The run of spaces/tabs immediately before `index`. Unlike {@link lineIndentAt}
 * this never includes a `{` from the same line, which matters for a one-line
 * `{"providers":{...}}` where the key is not the first character of the line.
 */
export function indentWhitespaceAt(text, index) {
  let start = index;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1;
  return text.slice(start, index);
}

/** @returns {{ newline: string, indentUnit: string }} */
export function detectFormat(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ...DEFAULT_FORMAT };
  return {
    newline: text.includes('\r\n') ? '\r\n' : '\n',
    indentUnit: detectIndentUnit(text),
  };
}

// ── rendering ───────────────────────────────────────────────────────

function isScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function renderJson(value, level, ctx) {
  if (isScalar(value)) return JSON.stringify(value);
  const { pad, newline } = ctx;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    const items = value.map((item) => `${pad(level + 1)}${renderJson(item, level + 1, ctx)}`);
    return `[${newline}${items.join(`,${newline}`)}${newline}${pad(level)}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  if (entries.length <= 4 && entries.every(([, item]) => isScalar(item))) {
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')} }`;
  }
  const body = entries.map(([key, item]) => `${pad(level + 1)}${JSON.stringify(key)}: ${renderJson(item, level + 1, ctx)}`);
  return `{${newline}${body.join(`,${newline}`)}${newline}${pad(level)}}`;
}

/**
 * Render one `"key": { … }` provider member in the file's own style.
 * @returns {string} the member text, without its leading indentation
 */
export function renderProviderMember(key, entry, { newline, indentUnit, memberIndent }) {
  const pad = (level) => memberIndent + indentUnit.repeat(level - 1);
  return `${JSON.stringify(key)}: ${renderJson(entry, 1, { pad, newline })}`;
}

// ── splices ─────────────────────────────────────────────────────────

function tailIndent(text, anchor, close) {
  const tail = text.slice(anchor, close);
  return tail.slice(tail.lastIndexOf('\n') + 1);
}

/**
 * Add (or replace) a provider member, leaving every other byte of the file untouched.
 *
 * @param {string} text the current file
 * @param {object} located result of {@link findProvidersObject}
 * @param {string} key the provider key
 * @param {object} entry the provider config (see {@link assertProviderEntryValid})
 * @returns {{ text: string, replaced: boolean }}
 */
export function spliceProvider(text, located, key, entry) {
  const { newline, indentUnit } = detectFormat(text);
  const providers = located.providers ?? [];
  const existing = providers.find((member) => member.key === key);
  const indentOf = (index) => lineIndentAt(text, index);

  if (existing !== undefined) {
    const memberIndent = indentOf(existing.keyStart);
    const rendered = renderProviderMember(key, entry, { newline, indentUnit, memberIndent });
    return { text: text.slice(0, existing.keyStart) + rendered + text.slice(existing.valueEnd), replaced: true };
  }

  if (located.providersOpen === undefined) {
    const rootMembers = located.rootMembers ?? [];
    const anchor = rootMembers.length > 0 ? rootMembers[rootMembers.length - 1].valueEnd : located.rootOpen + 1;
    const closingIndent = tailIndent(text, anchor, located.rootClose);
    const rootMemberIndent = rootMembers.length > 0 ? indentOf(rootMembers[0].keyStart) : closingIndent + indentUnit;
    const providersIndent = rootMemberIndent;
    const memberIndent = providersIndent + indentUnit;
    const rendered = renderProviderMember(key, entry, { newline, indentUnit, memberIndent });
    const providersText = `{${newline}${memberIndent}${rendered}${newline}${providersIndent}}`;
    const rootTail = `${rootMembers.length > 0 ? ',' : ''}${newline}${providersIndent}"providers": ${providersText}${newline}${closingIndent}`;
    return { text: text.slice(0, anchor) + rootTail + text.slice(located.rootClose), replaced: false };
  }

  const anchor = providers.length > 0 ? providers[providers.length - 1].valueEnd : located.providersOpen + 1;
  // An inline object has no line of its own. Two cases:
  //   * empty `{}` -- expand it, taking the indentation from the `"providers"` key;
  //   * non-empty but with its first member on the same line as `{` (MF-1) -- the
  //     old code read the whole line as the member indent and produced garbage
  //     that `assertSpliceSafe` then rejected with a misleading "would not parse".
  //     Put our member on its own line, keep the existing members byte-identical,
  //     and do not add a trailing close-indent so install + uninstall round-trips.
  const inline = providers.length > 0 && !text.slice(located.providersOpen, providers[0].keyStart).includes('\n');
  const closingIndent = providers.length > 0 && !inline
    ? tailIndent(text, anchor, located.providersClose)
    : indentWhitespaceAt(text, located.providersMember.keyStart);
  const memberIndent = providers.length > 0 && !inline ? indentOf(providers[0].keyStart) : closingIndent + indentUnit;
  const rendered = renderProviderMember(key, entry, { newline, indentUnit, memberIndent });
  const memberTail = inline
    ? `,${newline}${memberIndent}${rendered}`
    : `${providers.length > 0 ? ',' : ''}${newline}${memberIndent}${rendered}${newline}${closingIndent}`;
  return { text: text.slice(0, anchor) + memberTail + text.slice(located.providersClose), replaced: false };
}

/**
 * Remove one provider member, leaving every other byte untouched.
 * @returns {{ text: string, removed: boolean }}
 */
export function spliceProviderRemoval(text, located, key) {
  const providers = located.providers ?? [];
  const index = providers.findIndex((member) => member.key === key);
  if (index === -1) return { text, removed: false };
  const member = providers[index];
  const previous = providers[index - 1];
  const next = providers[index + 1];
  if (previous !== undefined) {
    return { text: text.slice(0, previous.valueEnd) + text.slice(member.valueEnd), removed: true };
  }
  if (next !== undefined) {
    return { text: text.slice(0, member.keyStart) + text.slice(next.keyStart), removed: true };
  }
  return { text: text.slice(0, located.providersOpen + 1) + text.slice(located.providersClose), removed: true };
}

/** An empty `{"providers": {}}` document in the given (or default) style. */
export function emptyModelsJson(format = DEFAULT_FORMAT) {
  const { newline, indentUnit } = format;
  return `{${newline}${indentUnit}"providers": {}${newline}}${newline}`;
}

// ── provider entry ──────────────────────────────────────────────────

/** Strip the gateway's legacy `workbuddy/` prefix from a catalog model id. */
export function canonicalModelId(id) {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  return trimmed.toLowerCase().startsWith(LEGACY_MODEL_PREFIX) ? trimmed.slice(LEGACY_MODEL_PREFIX.length) : trimmed;
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function modelEntry(id, model) {
  const entry = { id };
  if (typeof model.name === 'string' && model.name.trim() !== '' && model.name !== id) entry.name = model.name;
  if (model.supportsReasoning !== undefined) entry.reasoning = model.supportsReasoning === true;
  entry.input = model.supportsImages === true ? ['text', 'image'] : ['text'];
  if (positive(model.contextWindow)) entry.contextWindow = model.contextWindow;
  if (positive(model.maxTokens)) entry.maxTokens = model.maxTokens;
  // Billing happens upstream, per token. pi's cost table exists so a session can show
  // a number; this project never invents a price, so the honest local value is zero
  // (docs/mechanism.md, "no local accounting").
  entry.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return entry;
}

/**
 * Build the whole provider config from a catalog. Duplicate ids (a prefixed alias
 * next to its bare id) collapse into one entry.
 */
export function buildProviderEntry({ models, baseUrl, apiKey }) {
  const seen = new Set();
  const list = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = canonicalModelId(model?.id);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    list.push(modelEntry(id, model));
  }
  return { baseUrl, api: PROVIDER_API, apiKey, compat: { ...PROVIDER_COMPAT }, models: list };
}

/** The canonical pi model reference for one of our models. */
export function modelReference(id, providerKey = PROVIDER_KEY) {
  return `${providerKey}/${canonicalModelId(id)}`;
}

function fail(path, message) {
  throw new Error(`the provider entry would be rejected by pi's models.json schema at ${path}: ${message}`);
}

/**
 * Refuse to write an entry pi would reject. pi validates the whole file, so one
 * unknown key here would silently take every other provider down with it.
 */
export function assertProviderEntryValid(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail('providers.workbuddy', 'not an object');
  for (const key of Object.keys(entry)) if (!PROVIDER_KEYS.has(key)) fail(`providers.workbuddy.${key}`, 'unknown provider key');
  if (typeof entry.baseUrl !== 'string' || entry.baseUrl === '') fail('providers.workbuddy.baseUrl', 'must be a non-empty string');
  if (typeof entry.api !== 'string' || entry.api === '') fail('providers.workbuddy.api', 'must be a non-empty string');
  if (typeof entry.apiKey !== 'string' || entry.apiKey === '') fail('providers.workbuddy.apiKey', 'must be a non-empty string');
  if (entry.compat !== undefined) {
    if (typeof entry.compat !== 'object' || entry.compat === null || Array.isArray(entry.compat)) fail('providers.workbuddy.compat', 'not an object');
    for (const key of Object.keys(entry.compat)) if (!COMPAT_KEYS.has(key)) fail(`providers.workbuddy.compat.${key}`, 'unknown compat key');
  }
  if (!Array.isArray(entry.models) || entry.models.length === 0) fail('providers.workbuddy.models', 'must be a non-empty array');
  for (const model of entry.models) {
    if (typeof model !== 'object' || model === null || Array.isArray(model)) fail('providers.workbuddy.models[]', 'not an object');
    for (const key of Object.keys(model)) if (!MODEL_KEYS.has(key)) fail(`providers.workbuddy.models[].${key}`, 'unknown model key');
    if (typeof model.id !== 'string' || model.id === '') fail('providers.workbuddy.models[].id', 'must be a non-empty string');
    if (model.cost !== undefined) {
      if (typeof model.cost !== 'object' || model.cost === null) fail('providers.workbuddy.models[].cost', 'not an object');
      for (const key of Object.keys(model.cost)) if (!COST_KEYS.has(key)) fail(`providers.workbuddy.models[].cost.${key}`, 'unknown cost key');
    }
    if (model.input !== undefined && !model.input.every((item) => item === 'text' || item === 'image')) {
      fail('providers.workbuddy.models[].input', 'expected "text" and/or "image"');
    }
  }
  return true;
}

// ── verification and diffing ────────────────────────────────────────

/** Structural equality for parsed JSON (key order is irrelevant here on purpose). */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (typeof a === 'object') {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Fail closed unless the splice did exactly what it promised: every provider we did
 * not touch is unchanged, the provider order is unchanged, and ours is either present
 * with the expected value or gone.
 *
 * @param {{ before: object, afterText: string, key: string, entry?: object, expectPresent: boolean }} options
 */
export function assertSpliceSafe({ before, afterText, key, entry, expectPresent }) {
  let after;
  try {
    after = JSON.parse(stripBom(afterText));
  } catch (error) {
    throw new Error(`the edited models.json would not parse (${error.message}); nothing was written`);
  }
  const beforeProviders = (before && typeof before === 'object' && before.providers) || {};
  const afterProviders = (after && typeof after === 'object' && after.providers) || {};
  const beforeKeys = Object.keys(beforeProviders);
  const afterKeys = Object.keys(afterProviders);
  const expectedKeys = expectPresent
    ? (beforeKeys.includes(key) ? beforeKeys : [...beforeKeys, key])
    : beforeKeys.filter((name) => name !== key);
  if (afterKeys.join('\u0000') !== expectedKeys.join('\u0000')) {
    throw new Error('the edited models.json would change the provider list or its order; nothing was written');
  }
  for (const name of beforeKeys) {
    if (name === key) continue;
    if (!jsonEqual(beforeProviders[name], afterProviders[name])) {
      throw new Error(`the edited models.json would modify the unrelated provider ${JSON.stringify(name)}; nothing was written`);
    }
  }
  if (expectPresent) {
    if (afterProviders[key] === undefined) {
      throw new Error(`the edited models.json is missing the ${JSON.stringify(key)} provider; nothing was written`);
    }
    if (entry !== undefined && !jsonEqual(afterProviders[key], entry)) {
      throw new Error(`the edited models.json does not carry the expected ${JSON.stringify(key)} provider; nothing was written`);
    }
  } else if (afterProviders[key] !== undefined) {
    throw new Error(`the edited models.json still carries the ${JSON.stringify(key)} provider; nothing was written`);
  }
  return after;
}

/**
 * A minimal unified diff. The splices here change one contiguous region, so a
 * common-prefix / common-suffix split is exact rather than heuristic.
 */
export function lineDiff(before, after, { context = 3, path = 'models.json' } = {}) {
  if (before === after) return '';
  const strip = (line) => line.replace(/\r$/u, '');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const headStart = Math.max(0, prefix - context);
  const beforeTail = beforeLines.length - suffix;
  const afterTail = afterLines.length - suffix;
  const beforeTailEnd = Math.min(beforeLines.length, beforeTail + context);
  const afterTailEnd = Math.min(afterLines.length, afterTail + context);
  const beforeCount = (prefix - headStart) + removed.length + (beforeTailEnd - beforeTail);
  const afterCount = (prefix - headStart) + added.length + (afterTailEnd - afterTail);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${headStart + 1},${beforeCount} +${headStart + 1},${afterCount} @@`,
  ];
  for (let i = headStart; i < prefix; i += 1) lines.push(` ${strip(beforeLines[i])}`);
  for (const line of removed) lines.push(`-${strip(line)}`);
  for (const line of added) lines.push(`+${strip(line)}`);
  for (let i = beforeTail; i < beforeTailEnd; i += 1) lines.push(` ${strip(beforeLines[i])}`);
  return `${lines.join('\n')}\n`;
}
