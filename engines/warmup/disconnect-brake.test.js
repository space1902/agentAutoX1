import test from 'node:test';
import assert from 'node:assert/strict';

import { BRAKE, createDisconnectTracker, isLocalEvent } from './disconnect-brake.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 15, 0, 0);

const ids = (n) => Array.from({ length: n }, (_, i) => `tester${i + 1}`);

test('thresholds are named constants with the agreed starting values', () => {
  assert.equal(BRAKE.threshold, 5);
  assert.equal(BRAKE.windowMs, 60 * MIN);
  assert.equal(BRAKE.localEventFraction, 0.6);
  assert.equal(BRAKE.localEventWindowMs, 2 * MIN);
});

test('5 disconnects of one number within 60 min pause it once the burst has settled', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 5; i++) tracker.record({ session: 'tester1', at: T0 + i * 10 * MIN, fleetSize: 10 });
  const lastAt = T0 + 40 * MIN;

  assert.deepEqual(tracker.evaluate(lastAt + 30_000), [], 'still settling: another number might be going down too');
  const result = tracker.evaluate(lastAt + BRAKE.settleMs + 1000);
  assert.equal(result.length, 1);
  assert.equal(result[0].session, 'tester1');
  assert.equal(result[0].count, 5);
});

test('4 disconnects do not pause', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 4; i++) tracker.record({ session: 'tester1', at: T0 + i * 5 * MIN, fleetSize: 10 });
  assert.deepEqual(tracker.evaluate(T0 + 2 * 60 * MIN), []);
});

test('disconnects older than the 60 minute window are not counted', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 5; i++) tracker.record({ session: 'tester1', at: T0 + i * 17 * MIN, fleetSize: 10 });
  // 5 events span 68 min: at the last one only 4 are inside the hour.
  assert.deepEqual(tracker.evaluate(T0 + 68 * MIN + BRAKE.settleMs + 1000), []);
});

test('a local event (60%+ of sessions within 2 min) never counts toward any threshold', () => {
  const tracker = createDisconnectTracker();
  const fleet = ids(10);
  // A PC crash / network drop five times in one hour: 7 of 10 numbers drop each time.
  for (let round = 0; round < 5; round++) {
    fleet.slice(0, 7).forEach((session, i) => tracker.record({ session, at: T0 + round * 10 * MIN + i * 5000, fleetSize: 10 }));
  }
  assert.deepEqual(tracker.evaluate(T0 + 50 * MIN + BRAKE.settleMs + 1000), []);
  assert.equal(tracker.count('tester1', T0 + 50 * MIN + BRAKE.settleMs + 1000), 0);
});

test('only the disconnects inside local events are excluded; the rest still count', () => {
  const tracker = createDisconnectTracker();
  // tester1: 3 own disconnects + 2 inside fleet-wide drops = 3 counted, no pause.
  [0, 10, 20].forEach((m) => tracker.record({ session: 'tester1', at: T0 + m * MIN, fleetSize: 10 }));
  [30, 40].forEach((m) => {
    ids(7).forEach((session, i) => tracker.record({ session, at: T0 + m * MIN + i * 3000, fleetSize: 10 }));
  });
  const now = T0 + 40 * MIN + BRAKE.settleMs + 1000;
  assert.equal(tracker.count('tester1', now), 3);
  assert.deepEqual(tracker.evaluate(now), []);

  // The same number keeps flapping alone: now it crosses the threshold.
  [45, 50].forEach((m) => tracker.record({ session: 'tester1', at: T0 + m * MIN, fleetSize: 10 }));
  const later = T0 + 50 * MIN + BRAKE.settleMs + 1000;
  assert.equal(tracker.count('tester1', later), 5);
  assert.equal(tracker.evaluate(later)[0].session, 'tester1');
});

test('the 60% boundary: 6 of 10 is local, 5 of 10 is not', () => {
  const six = [];
  ids(6).forEach((session, i) => six.push({ session, at: T0 + i * 1000, fleet: 10 }));
  assert.equal(isLocalEvent(six[0], six, BRAKE), true);

  const five = six.slice(0, 5);
  assert.equal(isLocalEvent(five[0], five, BRAKE), false);
});

test('the cluster must fit inside 2 minutes; a slow trickle is not a local event', () => {
  const events = ids(8).map((session, i) => ({ session, at: T0 + i * MIN, fleet: 10 }));
  assert.equal(isLocalEvent(events[0], events, BRAKE), false);
  assert.equal(isLocalEvent(events[3], events, BRAKE), false);

  const quick = ids(8).map((session, i) => ({ session, at: T0 + i * 10_000, fleet: 10 }));
  assert.equal(isLocalEvent(quick[0], quick, BRAKE), true);
});

test('a lone number is never "a majority": with one session the threshold still applies', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 5; i++) tracker.record({ session: 'tester1', at: T0 + i * 5 * MIN, fleetSize: 1 });
  const result = tracker.evaluate(T0 + 20 * MIN + BRAKE.settleMs + 1000);
  assert.equal(result.length, 1);
});

test('two numbers dropping together out of two is a local event', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 5; i++) {
    tracker.record({ session: 'a', at: T0 + i * 10 * MIN, fleetSize: 2 });
    tracker.record({ session: 'b', at: T0 + i * 10 * MIN + 4000, fleetSize: 2 });
  }
  assert.deepEqual(tracker.evaluate(T0 + 40 * MIN + BRAKE.settleMs + 1000), []);
});

test('reconnects right after a start do not count (startup grace)', () => {
  const tracker = createDisconnectTracker();
  tracker.markStarted('tester1', T0);
  for (let i = 0; i < 6; i++) tracker.record({ session: 'tester1', at: T0 + 10_000 + i * 15_000, fleetSize: 10 });
  assert.equal(tracker.count('tester1', T0 + 5 * MIN), 0);
  assert.deepEqual(tracker.evaluate(T0 + 10 * MIN), []);

  // After the grace period disconnects count again.
  tracker.record({ session: 'tester1', at: T0 + BRAKE.startupGraceMs + 1000, fleetSize: 10 });
  assert.equal(tracker.count('tester1', T0 + 10 * MIN), 1);
});

test('an event flagged as exempt (the PC was suspended) is ignored', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 6; i++) tracker.record({ session: 'tester1', at: T0 + i * MIN, fleetSize: 10, exempt: true });
  assert.deepEqual(tracker.evaluate(T0 + 30 * MIN), []);
});

test('clear() forgets a number after it was paused, so it starts fresh when resumed', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 5; i++) tracker.record({ session: 'tester1', at: T0 + i * MIN, fleetSize: 10 });
  const now = T0 + 5 * MIN + BRAKE.settleMs + 1000;
  assert.equal(tracker.evaluate(now).length, 1);
  tracker.clear('tester1');
  assert.deepEqual(tracker.evaluate(now), []);
  assert.equal(tracker.count('tester1', now), 0);
});

test('old events are pruned so a very long run keeps bounded memory', () => {
  const tracker = createDisconnectTracker();
  for (let i = 0; i < 500; i++) tracker.record({ session: 'tester1', at: T0 + i * 10 * MIN, fleetSize: 10 });
  assert.ok(tracker.size() < 50, `kept ${tracker.size()} events`);
});
