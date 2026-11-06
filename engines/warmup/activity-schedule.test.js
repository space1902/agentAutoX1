import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULE_DEFAULTS,
  dailyCap,
  dateKeyFor,
  dayWindow,
  evaluateGate,
  isLowActivityDay,
  normalizeSchedule,
  resolveTimezone,
  spreadDelayMs,
  zonedWallToUtcMs,
} from './activity-schedule.js';

const BOGOTA = 'America/Bogota';
const schedule = normalizeSchedule(undefined);
const minutesOf = (ms, tz = BOGOTA) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms))
    .reduce((acc, p) => ({ ...acc, [p.type]: Number(p.value) }), {});
  return parts.hour * 60 + parts.minute;
};

test('normalizeSchedule: absent config gives the documented defaults and stays enabled', () => {
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.timezone, 'America/Bogota');
  assert.deepEqual(schedule.start, { min: 420, max: 570 });
  assert.deepEqual(schedule.end, { min: 1230, max: 1350 });
  assert.equal(schedule.botDailyCap, 150);
  assert.deepEqual(
    schedule.caps.map((c) => c.cap),
    [20, 40, 80, 150],
  );
  assert.equal(SCHEDULE_DEFAULTS.enabled, true);
});

test('normalizeSchedule: can be turned off and overridden; garbage falls back to defaults', () => {
  assert.equal(normalizeSchedule({ enabled: false }).enabled, false);
  assert.equal(normalizeSchedule({ timezone: 'America/Mexico_City' }).timezone, 'America/Mexico_City');
  assert.equal(normalizeSchedule({ timezone: 'Not/AZone' }).timezone, 'America/Bogota');
  const custom = normalizeSchedule({ botDailyCap: 99, dailyCaps: { days1to3: 5 }, window: { start: { min: '06:00', max: '06:30' } } });
  assert.equal(custom.botDailyCap, 99);
  assert.equal(custom.caps[0].cap, 5);
  assert.equal(custom.caps[1].cap, 40);
  assert.deepEqual(custom.start, { min: 360, max: 390 });
  assert.deepEqual(normalizeSchedule('nonsense').start, { min: 420, max: 570 });
  assert.deepEqual(normalizeSchedule({ window: { start: { min: 'xx', max: '99:99' } } }).start, { min: 420, max: 570 });
});

test('resolveTimezone: a per-entry timezone wins, an invalid one is ignored', () => {
  assert.equal(resolveTimezone(schedule, { id: 'a', timezone: 'America/Mexico_City' }), 'America/Mexico_City');
  assert.equal(resolveTimezone(schedule, { id: 'a', timezone: 'bad' }), BOGOTA);
  assert.equal(resolveTimezone(schedule, 'tester1'), BOGOTA);
  assert.equal(resolveTimezone(schedule, undefined), BOGOTA);
});

test('dateKeyFor: uses the local calendar day, not UTC', () => {
  // 2026-11-04T03:30:00Z is still 2026-11-03 22:30 in Bogota (UTC-5).
  const ms = Date.UTC(2026, 10, 4, 3, 30);
  assert.equal(dateKeyFor(ms, BOGOTA), '2026-11-03');
  assert.equal(dateKeyFor(ms, 'UTC'), '2026-11-04');
  // 05:00Z is exactly local midnight.
  assert.equal(dateKeyFor(Date.UTC(2026, 10, 4, 5, 0), BOGOTA), '2026-11-04');
  assert.equal(dateKeyFor(Date.UTC(2026, 10, 4, 4, 59, 59), BOGOTA), '2026-11-03');
});

test('zonedWallToUtcMs: converts a local wall time to the right instant', () => {
  assert.equal(zonedWallToUtcMs('2026-11-03', 8 * 60, BOGOTA), Date.UTC(2026, 10, 3, 13, 0));
  assert.equal(zonedWallToUtcMs('2026-11-03', 0, BOGOTA), Date.UTC(2026, 10, 3, 5, 0));
  // Mexico City has no DST since 2022: UTC-6.
  assert.equal(zonedWallToUtcMs('2026-07-01', 9 * 60, 'America/Mexico_City'), Date.UTC(2026, 6, 1, 15, 0));
});

test('dayWindow: stays inside the configured ranges for many sessions and days', () => {
  for (let s = 1; s <= 20; s++) {
    for (let d = 1; d <= 30; d++) {
      const key = `2026-11-${String(d).padStart(2, '0')}`;
      const w = dayWindow(`tester${s}`, key, schedule, BOGOTA);
      const start = minutesOf(w.startMs);
      const end = minutesOf(w.endMs);
      assert.ok(start >= 420 && start <= 570, `start ${start}`);
      assert.ok(end >= 1230 && end <= 1350, `end ${end}`);
      assert.equal(dateKeyFor(w.startMs, BOGOTA), key);
      assert.equal(dateKeyFor(w.endMs, BOGOTA), key);
    }
  }
});

test('dayWindow: deterministic for the same session and day, varies across days and sessions', () => {
  const a1 = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  const a2 = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  assert.deepEqual(a1, a2);

  const starts = new Set();
  for (let d = 1; d <= 14; d++) starts.add(dayWindow('tester1', `2026-11-${String(d).padStart(2, '0')}`, schedule, BOGOTA).startMs % 86_400_000);
  assert.ok(starts.size >= 6, 'start time varies from day to day');

  const sameDay = new Set();
  for (let s = 1; s <= 10; s++) sameDay.add(dayWindow(`tester${s}`, '2026-11-03', schedule, BOGOTA).startMs);
  assert.ok(sameDay.size >= 6, 'numbers get different windows on the same day');
});

test('isLowActivityDay: about one day in seven per number, never the same pattern for all numbers', () => {
  const days = [];
  for (let i = 0; i < 70; i++) days.push(dateKeyFor(Date.UTC(2026, 9, 1 + i, 12), BOGOTA));

  for (let s = 1; s <= 12; s++) {
    const low = days.filter((d) => isLowActivityDay(`tester${s}`, d, schedule));
    assert.ok(low.length >= 8 && low.length <= 12, `tester${s} has ${low.length} low days in 70`);
  }

  // Exactly one per 7-day block, so a single week never holds two.
  const firstBlock = days.slice(0, 7).filter((d) => isLowActivityDay('tester1', d, schedule));
  assert.ok(firstBlock.length <= 1);

  // Not every number lands on the same day.
  const perDay = days.map((d) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((s) => isLowActivityDay(`tester${s}`, d, schedule)).length);
  assert.ok(Math.max(...perDay) < 10, 'never all ten at once');
  assert.ok(Math.max(...perDay) <= 5);

  // Deterministic.
  assert.equal(isLowActivityDay('tester3', days[10], schedule), isLowActivityDay('tester3', days[10], schedule));
});

test('dailyCap: by age', () => {
  const cap = (days, incidents = 0) => dailyCap({ days, incidents, schedule }).cap;
  assert.equal(cap(1), 20);
  assert.equal(cap(3), 20);
  assert.equal(cap(4), 40);
  assert.equal(cap(7), 40);
  assert.equal(cap(8), 80);
  assert.equal(cap(14), 80);
  assert.equal(cap(15), 150);
  assert.equal(cap(400), 150);
});

test('dailyCap: an incident drops one level; the lowest level is halved', () => {
  const cap = (days, incidents) => dailyCap({ days, incidents, schedule });
  assert.equal(cap(20, 1).cap, 80);
  assert.equal(cap(10, 2).cap, 40);
  assert.equal(cap(5, 1).cap, 20);
  assert.equal(cap(2, 1).cap, 10);
  assert.equal(cap(20, 1).downgraded, true);
  assert.equal(cap(20, 0).downgraded, false);
});

test('dailyCap: unknown age is treated as the safest level', () => {
  assert.equal(dailyCap({ days: null, incidents: 0, schedule }).cap, 20);
  assert.equal(dailyCap({ days: undefined, incidents: 0, schedule }).cap, 20);
  assert.equal(dailyCap({ days: Number.NaN, incidents: 0, schedule }).cap, 20);
});

const NOW_KEY = '2026-11-03';
function gateAt(offsetMs, extra = {}) {
  const window = dayWindow('tester1', NOW_KEY, schedule, BOGOTA);
  return {
    window,
    gate: evaluateGate({
      sessionId: 'tester1',
      now: window.startMs + offsetMs,
      count: 0,
      days: 20,
      incidents: 0,
      schedule,
      timezone: BOGOTA,
      ...extra,
    }),
  };
}

test('evaluateGate: outside the window sends nothing and points at the next opening', () => {
  const { window, gate: early } = gateAt(-60_000);
  assert.equal(early.state, 'outside_window');
  assert.equal(early.nextOpenMs, window.startMs);

  const { gate: late } = gateAt(window.endMs - window.startMs + 1000);
  assert.equal(late.state, 'outside_window');
  const tomorrow = dayWindow('tester1', '2026-11-04', schedule, BOGOTA);
  assert.equal(late.nextOpenMs, tomorrow.startMs);
});

test('evaluateGate: inside the window it is active until the cap is reached', () => {
  const { gate } = gateAt(60_000, { count: 5 });
  assert.equal(gate.state, 'active');
  assert.equal(gate.count, 5);

  const lowAdjusted = gateAt(60_000, { count: 0 }).gate;
  assert.ok(lowAdjusted.cap === 150 || lowAdjusted.cap === 45, 'cap is the base cap or 30% of it on a low-activity day');

  const { gate: capped, window } = gateAt(60_000, { count: 500 });
  assert.equal(capped.state, 'capped');
  assert.equal(capped.nextOpenMs, dayWindow('tester1', '2026-11-04', schedule, BOGOTA).startMs);
  assert.ok(capped.nextOpenMs > window.endMs);
});

test('evaluateGate: a low-activity day uses 30% of the cap', () => {
  let key = null;
  for (let d = 1; d <= 28 && !key; d++) {
    const k = `2026-11-${String(d).padStart(2, '0')}`;
    if (isLowActivityDay('tester1', k, schedule)) key = k;
  }
  assert.ok(key, 'some day in 28 is low-activity');
  const window = dayWindow('tester1', key, schedule, BOGOTA);
  const gate = evaluateGate({ sessionId: 'tester1', now: window.startMs + 1000, count: 0, days: 30, incidents: 0, schedule, timezone: BOGOTA });
  assert.equal(gate.low, true);
  assert.equal(gate.baseCap, 150);
  assert.equal(gate.cap, 45);
});

test('evaluateGate: a flat cap (the bot) ignores age', () => {
  const window = dayWindow('bot', NOW_KEY, schedule, BOGOTA);
  const gate = evaluateGate({ sessionId: 'bot', now: window.startMs + 1000, count: 0, flatCap: schedule.botDailyCap, schedule, timezone: BOGOTA });
  assert.equal(gate.baseCap, 150);
});

test('evaluateGate: the count is by local day, so a restart does not reset the cap', () => {
  // Same local day, different UTC day: 22:00 Bogota on the 3rd is already the 4th in UTC.
  const window = dayWindow('tester1', NOW_KEY, schedule, BOGOTA);
  const late = evaluateGate({ sessionId: 'tester1', now: window.endMs - 30 * 60_000, count: 500, days: 20, incidents: 0, schedule, timezone: BOGOTA });
  assert.equal(late.dateKey, NOW_KEY);
  assert.equal(late.state, 'capped');
});

test('evaluateGate: disabled schedule never blocks', () => {
  const off = normalizeSchedule({ enabled: false });
  const gate = evaluateGate({ sessionId: 'tester1', now: Date.UTC(2026, 10, 3, 7, 0), count: 9999, days: 1, incidents: 0, schedule: off, timezone: BOGOTA });
  assert.equal(gate.state, 'active');
  assert.equal(gate.cap, null);
});

test('spreadDelayMs: spreads the remaining cap over the remaining window with jitter', () => {
  const now = 1_000_000;
  const endMs = now + 10 * 3_600_000;
  const mid = spreadDelayMs({ now, windowEndMs: endMs, cap: 100, count: 0, random: () => 0.5 });
  assert.equal(mid, 360_000);
  const low = spreadDelayMs({ now, windowEndMs: endMs, cap: 100, count: 0, random: () => 0 });
  const high = spreadDelayMs({ now, windowEndMs: endMs, cap: 100, count: 0, random: () => 1 });
  assert.ok(low < mid && mid < high);
  assert.ok(low >= 360_000 * 0.6 && high <= 360_000 * 1.4);

  // Fewer messages remaining means longer gaps.
  const later = spreadDelayMs({ now, windowEndMs: endMs, cap: 100, count: 90, random: () => 0.5 });
  assert.ok(later > mid);
});

test('spreadDelayMs: no cap or no window left means no extra delay', () => {
  assert.equal(spreadDelayMs({ now: 10, windowEndMs: 5, cap: 100, count: 0, random: () => 0.5 }), 0);
  assert.equal(spreadDelayMs({ now: 10, windowEndMs: 500, cap: null, count: 0, random: () => 0.5 }), 0);
  assert.equal(spreadDelayMs({ now: 10, windowEndMs: 500, cap: 10, count: 10, random: () => 0.5 }), 0);
});
