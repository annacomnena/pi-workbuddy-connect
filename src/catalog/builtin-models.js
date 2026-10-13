// Built-in model placeholder.
//
// This is the last rung of the catalog degradation chain (live -> saved ->
// built-in). The upstream roster churns within days, so this list is a
// boot-time placeholder, never a promise: it exists so a first run with no
// network still has a shape to show, and it is always labelled with its
// source. Rows intentionally carry no pricing or context-window claims.
//
// Provenance: model ids observed in the upstream's own fallback table and in
// research notes (see docs/mechanism.md). No values were copied from any
// credential.

export const BUILTIN_MODELS = Object.freeze([
  Object.freeze({ id: 'auto', name: 'Auto' }),
  Object.freeze({ id: 'hy3', name: 'Hy3' }),
  Object.freeze({ id: 'hy4-preview', name: 'Hy4 preview' }),
  Object.freeze({ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }),
  Object.freeze({ id: 'glm-5.3', name: 'GLM-5.3' }),
  Object.freeze({ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }),
  Object.freeze({ id: 'kimi-k3-1', name: 'Kimi-K3-1' }),
  Object.freeze({ id: 'minimax-m3', name: 'MiniMax-M3' }),
]);

export const BUILTIN_STALE_NOTE =
  'built-in placeholder; the upstream roster churns, refresh to replace it';
