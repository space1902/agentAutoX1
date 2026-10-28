import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateRates,
  formatEstimate,
  hourlyWaitMs,
  initialOffsetMs,
  nextDelayMs,
  pruneSentAt,
  resolveTesterSettings,
} from './tester-schedule.js';

const GLOBALS = {
  delaySeconds: { min: 20, max: 60 },
  maxMessagesPerTesterPerHour: 40,
};

const HOUR = 60 * 60 * 1000;

test('resolveTesterSettings: string entry uses global values', () => {
  assert.deepEqual(resolveTesterSettings('tester1', GLOBALS), {
    id: 'tester1',
    delaySeconds: { min: 20, max: 60 },
    maxPerHour: 40,
  });
});

test('resolveTesterSettings: object entry overrides fields', () => {
  const settings = resolveTesterSettings(
    { id: 'tester3', delaySeconds: { min: 100, max: 200 }, maxMessagesPerHour: 10 },
    GLOBALS,
  );
  assert.deepEqual(settings, {
    id: 'tester3',
    delaySeconds: { min: 100, max: 200 },
    maxPerHour: 10,
  });
});

test('resolveTesterSettings: partial object falls back to globals', () => {
  const settings = resolveTesterSettings({ id: 'tester4', maxMessagesPerHour: 5 }, GLOBALS);
  assert.deepEqual(settings.delaySeconds, { min: 20, max: 60 });
  assert.equal(settings.maxPerHour, 5);

  const onlyDelay = resolveTesterSettings(
    { id: 'tester5', delaySeconds: { min: 5, max: 6 } },
    GLOBALS,
  );
  assert.equal(onlyDelay.maxPerHour, 40);
});

test('resolveTesterSettings: swaps inverted delays and clamps invalid values', () => {
  const swapped = resolveTesterSettings(
    { id: 'a', delaySeconds: { min: 90, max: 30 } },
    GLOBALS,
  );
  assert.deepEqual(swapped.delaySeconds, { min: 30, max: 90 });

  const clamped = resolveTesterSettings(
    { id: 'b', delaySeconds: { min: 0, max: -3 }, maxMessagesPerHour: 0 },
    GLOBALS,
  );
  assert.equal(clamped.delaySeconds.min >= 1, true);
  assert.equal(clamped.delaySeconds.max >= clamped.delaySeconds.min, true);
  assert.equal(clamped.maxPerHour, 40);
});

test('resolveTesterSettings: entries without id are rejected', () => {
  assert.equal(resolveTesterSettings({ delaySeconds: { min: 1, max: 2 } }, GLOBALS), null);
  assert.equal(resolveTesterSettings('', GLOBALS), null);
  assert.equal(resolveTesterSettings(null, GLOBALS), null);
});

test('nextDelayMs: stays inside [min, max] in milliseconds', () => {
  const s = { delaySeconds: { min: 20, max: 60 } };
  assert.equal(nextDelayMs(s, () => 0), 20_000);
  assert.equal(nextDelayMs(s, () => 0.5), 40_000);
  assert.equal(nextDelayMs(s, () => 0.999999) <= 60_000, true);
});

test('initialOffsetMs: random in [0, max seconds]', () => {
  const s = { delaySeconds: { min: 20, max: 60 } };
  assert.equal(initialOffsetMs(s, () => 0), 0);
  assert.equal(initialOffsetMs(s, () => 0.5), 30_000);
});

test('pruneSentAt: drops timestamps older than one hour', () => {
  const now = 10 * HOUR;
  assert.deepEqual(pruneSentAt([now - HOUR - 1, now - HOUR + 1, now - 5], now), [
    now - HOUR + 1,
    now - 5,
  ]);
});

test('hourlyWaitMs: 0 below the cap', () => {
  const now = 10 * HOUR;
  assert.equal(hourlyWaitMs([now - 1000, now - 2000], now, 3), 0);
  assert.equal(hourlyWaitMs([], now, 1), 0);
});

test('hourlyWaitMs: at the cap waits until the oldest message leaves the window', () => {
  const now = 10 * HOUR;
  const sentAt = [now - HOUR + 30_000, now - 1000];
  // Oldest leaves the window in 30s; 1s safety margin.
  assert.equal(hourlyWaitMs(sentAt, now, 2), 31_000);
});

test('hourlyWaitMs: ignores timestamps already outside the window', () => {
  const now = 10 * HOUR;
  assert.equal(hourlyWaitMs([now - HOUR - 5000, now - 10], now, 2), 0);
});

test('estimateRates: per tester = min(3600/avgDelay, maxPerHour), plus total', () => {
  const testers = [
    { id: 'a', delaySeconds: { min: 20, max: 60 }, maxPerHour: 40 }, // avg 40 -> 90 -> capped 40
    { id: 'b', delaySeconds: { min: 300, max: 300 }, maxPerHour: 40 }, // 12
    { id: 'c', delaySeconds: { min: 100, max: 140 }, maxPerHour: 5 }, // 30 -> capped 5
  ];
  const est = estimateRates(testers);
  assert.deepEqual(
    est.perTester.map((t) => [t.id, t.perHour]),
    [['a', 40], ['b', 12], ['c', 5]],
  );
  assert.equal(est.totalPerHour, 57);
  assert.equal(est.perTester[0].avgDelaySeconds, 40);
});

test('formatEstimate: mentions every tester and the total API calls', () => {
  const est = estimateRates([
    { id: 'tester1', delaySeconds: { min: 100, max: 200 }, maxPerHour: 40 },
  ]);
  const text = formatEstimate(est);
  assert.match(text, /tester1/);
  assert.match(text, /24(\.0)?\/h/);
  assert.match(text, /API calls\/hour/i);
});
