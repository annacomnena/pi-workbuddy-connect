import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  ModelCooldowns,
  clampCooldown,
  cooldownSecondsFrom,
  cooldownUntilFromBody,
  parseCooldownTime,
} from '../src/gateway/cooldown.js';

test('a Retry-After hint wins over the default', () => {
  assert.equal(cooldownSecondsFrom({ retryAfterSeconds: 12 }), 12);
  assert.equal(cooldownSecondsFrom({}), DEFAULT_COOLDOWN_SECONDS);
});

test('hints are clamped to the observed two-hour ceiling', () => {
  assert.equal(clampCooldown(999_999), MAX_COOLDOWN_SECONDS);
  assert.equal(clampCooldown(0), DEFAULT_COOLDOWN_SECONDS);
  assert.equal(clampCooldown(-5), DEFAULT_COOLDOWN_SECONDS);
});

test('a UTC+8 wall-clock hint in the body is honoured', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  assert.equal(parseCooldownTime('2026-10-13 18:30:00'), Date.parse('2026-10-13T10:30:00Z'));
  const body = JSON.stringify({ code: 6004, data: { cooldownUntil: '2026-10-13 18:05:00' } });
  assert.equal(cooldownSecondsFrom({ body, now }), 300);
  assert.equal(cooldownUntilFromBody('not json'), undefined);
  assert.equal(cooldownUntilFromBody('{"data":{"note":"no time here"}}'), undefined);
});

test('cooldowns are per model and expire on their own', () => {
  let clock = 1_000_000;
  const cooldowns = new ModelCooldowns({ now: () => clock });
  cooldowns.penalize('hy3', 30);
  assert.equal(cooldowns.status('hy3').cooling, true);
  assert.equal(cooldowns.status('hy3').retryAfterSeconds, 30);
  assert.equal(cooldowns.status('glm-5.3').cooling, false);
  clock += 31_000;
  assert.equal(cooldowns.status('hy3').cooling, false);
});

test('a longer cooldown extends an existing one, a shorter one does not shorten it', () => {
  let clock = 0;
  const cooldowns = new ModelCooldowns({ now: () => clock });
  cooldowns.penalize('hy3', 60, clock);
  cooldowns.penalize('hy3', 10, clock);
  assert.equal(cooldowns.status('hy3', clock).retryAfterSeconds, 60);
  cooldowns.penalize('hy3', 600, clock);
  assert.equal(cooldowns.status('hy3', clock).retryAfterSeconds, 600);
});

test('the snapshot exposes only active cooldowns', () => {
  let clock = 0;
  const cooldowns = new ModelCooldowns({ now: () => clock });
  cooldowns.penalize('hy3', 60, clock);
  cooldowns.penalize('glm-5.3', 5, clock);
  clock = 10_000;
  assert.deepEqual(cooldowns.snapshot(clock), { hy3: 50 });
  cooldowns.clear('hy3');
  assert.deepEqual(cooldowns.snapshot(clock), {});
});
