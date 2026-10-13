import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareChatBody,
  parseChatRequest,
  stripModelPrefix,
  withModelPrefix,
  normalizeToolChoice,
  normalizeDeveloperRole,
  dropUnsupportedEffort,
  ensureFirstSystem,
} from '../src/protocol/body.js';

test('model ids round-trip through the workbuddy/ prefix', () => {
  assert.equal(withModelPrefix('hy3'), 'workbuddy/hy3');
  assert.equal(stripModelPrefix('workbuddy/hy3'), 'hy3');
  assert.equal(stripModelPrefix('WORKBUDDY/hy3'), 'hy3');
  assert.equal(stripModelPrefix('hy3'), 'hy3');
  assert.equal(stripModelPrefix(undefined), '');
});

test('parseChatRequest validates model and messages', () => {
  assert.equal(parseChatRequest('not json').ok, false);
  assert.equal(parseChatRequest('[]').ok, false);
  assert.equal(parseChatRequest('{"model":"hy3"}').ok, false);
  assert.equal(parseChatRequest('{"model":"","messages":[{"role":"user"}]}').ok, false);
  assert.equal(parseChatRequest('{"model":"hy3","messages":[]}').ok, false);
  const good = parseChatRequest('{"model":"hy3","messages":[{"role":"user","content":"hi"}]}');
  assert.equal(good.ok, true);
  assert.equal(good.value.model, 'hy3');
});

test('stream is forced on: the upstream rejects non-streaming bodies', () => {
  const body = JSON.parse(prepareChatBody({ model: 'workbuddy/hy3', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(body.stream, true);
  assert.equal(body.model, 'hy3');
});

test('role developer is rewritten to system', () => {
  const input = { messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }] };
  normalizeDeveloperRole(input);
  assert.equal(input.messages[0].role, 'system');
});

test('tool_choice object forms are flattened to the upstream string form', () => {
  const auto = { tool_choice: { type: 'auto' } };
  normalizeToolChoice(auto);
  assert.equal(auto.tool_choice, 'auto');

  const required = { tool_choice: { type: 'required' } };
  normalizeToolChoice(required);
  assert.equal(required.tool_choice, 'required');

  const named = { tool_choice: { type: 'function', function: { name: 'get_weather' } } };
  normalizeToolChoice(named);
  assert.equal(named.tool_choice, 'get_weather');

  // `none` also removes the declarations, because deleting only tool_choice
  // would re-enable automatic tool use.
  const none = { tool_choice: { type: 'none' }, tools: [{ type: 'function' }] };
  normalizeToolChoice(none);
  assert.equal('tool_choice' in none, false);
  assert.equal('tools' in none, false);

  const noneString = { tool_choice: 'none', functions: [{}] };
  normalizeToolChoice(noneString);
  assert.equal('tool_choice' in noneString, false);
  assert.equal('functions' in noneString, false);

  const unknown = { tool_choice: { type: 'wat' } };
  normalizeToolChoice(unknown);
  assert.equal('tool_choice' in unknown, false);
});

test('reasoning_effort "off" is dropped, other values pass through', () => {
  const off = { reasoning_effort: 'off' };
  dropUnsupportedEffort(off);
  assert.equal('reasoning_effort' in off, false);
  const high = { reasoning_effort: 'high' };
  dropUnsupportedEffort(high);
  assert.equal(high.reasoning_effort, 'high');
});

test('the global region gets a leading system message without merging', () => {
  const input = { messages: [{ role: 'user', content: 'hi' }] };
  ensureFirstSystem(input);
  assert.equal(input.messages.length, 2);
  assert.equal(input.messages[0].role, 'system');
  assert.equal(input.messages[1].content, 'hi');

  const already = { messages: [{ role: 'system', content: 'keep' }, { role: 'user', content: 'hi' }] };
  ensureFirstSystem(already);
  assert.equal(already.messages.length, 2);
  assert.equal(already.messages[0].content, 'keep');
});

test('prepareChatBody applies every quirk for the global region', () => {
  const body = JSON.parse(prepareChatBody({
    model: 'workbuddy/glm-5.3',
    stream: false,
    reasoning_effort: 'off',
    tool_choice: { type: 'function', function: { name: 'f' } },
    messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
  }, { region: 'global' }));
  assert.equal(body.stream, true);
  assert.equal(body.model, 'glm-5.3');
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.tool_choice, 'f');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages.length, 2);
});

test('the cn region does not inject a system message', () => {
  const body = JSON.parse(prepareChatBody({
    model: 'hy3',
    messages: [{ role: 'user', content: 'hi' }],
  }, { region: 'cn' }));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
});
