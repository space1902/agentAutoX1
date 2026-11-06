import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dayWindow, normalizeSchedule } from './activity-schedule.js';
import { countSentOnDay, createSendGate } from './send-gate.js';

const BOGOTA = 'America/Bogota';
const schedule = normalizeSchedule(undefined);

function tempResults() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-gate-'));
  const write = (session, records) =>
    fs.writeFileSync(path.join(dir, `activity-${session}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, write, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const sec = (ms) => Math.floor(ms / 1000);
const sent = (ms) => ({ t: sec(ms), me: 1, chat: 'group', type: 'chat', len: 10 });
const received = (ms) => ({ t: sec(ms), me: 0, chat: 'group', type: 'chat', len: 10 });

test('countSentOnDay: counts only my messages of that LOCAL day (the UTC trap)', () => {
  const t = tempResults();
  t.write('tester1', [
    sent(Date.UTC(2026, 10, 3, 4, 59)), // 23:59 on the 2nd in Bogota (but the 3rd in UTC)
    sent(Date.UTC(2026, 10, 3, 5, 0)), // 00:00 on the 3rd
    sent(Date.UTC(2026, 10, 3, 14, 0)),
    received(Date.UTC(2026, 10, 3, 14, 5)),
    sent(Date.UTC(2026, 10, 4, 3, 30)), // 22:30 on the 3rd in Bogota (the 4th in UTC)
    sent(Date.UTC(2026, 10, 4, 5, 0)), // 00:00 on the 4th
  ]);
  assert.equal(countSentOnDay({ resultsDir: t.dir, session: 'tester1', dateKey: '2026-11-03', timezone: BOGOTA }), 3);
  assert.equal(countSentOnDay({ resultsDir: t.dir, session: 'tester1', dateKey: '2026-11-04', timezone: BOGOTA }), 1);
  assert.equal(countSentOnDay({ resultsDir: t.dir, session: 'tester1', dateKey: '2026-11-03', timezone: 'UTC' }), 3);
  assert.equal(countSentOnDay({ resultsDir: t.dir, session: 'nobody', dateKey: '2026-11-03', timezone: BOGOTA }), 0);
  t.cleanup();
});

function gateFor(t, session, nowRef, extra = {}) {
  return createSendGate({
    sessionId: session,
    schedule,
    timezone: BOGOTA,
    resultsDir: t.dir,
    getAge: () => ({ days: 20, incidents: 0 }),
    now: () => nowRef.ms,
    ...extra,
  });
}

test('the daily count survives a restart: a new gate rebuilds it from the activity log', () => {
  const t = tempResults();
  const window = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  const nowRef = { ms: window.startMs + 3_600_000 };
  const before = [];
  for (let i = 0; i < 12; i++) before.push(sent(window.startMs + 60_000 * (i + 1)));
  t.write('tester1', before);

  const first = gateFor(t, 'tester1', nowRef);
  assert.equal(first.check().count, 12);
  first.recordSent();
  assert.equal(first.check().count, 13);

  // "Restart": a fresh gate, and the log now holds 13 sends.
  t.write('tester1', [...before, sent(nowRef.ms)]);
  const second = gateFor(t, 'tester1', nowRef);
  assert.equal(second.check().count, 13);
  t.cleanup();
});

test('a restart on a capped day stays capped (does not reset the cap)', () => {
  const t = tempResults();
  const window = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  const nowRef = { ms: window.startMs + 3_600_000 };
  const many = [];
  for (let i = 0; i < 400; i++) many.push(sent(window.startMs + 1000 * (i + 1)));
  t.write('tester1', many);
  const gate = gateFor(t, 'tester1', nowRef);
  const status = gate.check();
  assert.equal(status.state, 'capped');
  assert.ok(status.nextOpenMs > nowRef.ms);
  t.cleanup();
});

test('crossing local midnight starts a fresh count', () => {
  const t = tempResults();
  const day1 = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  const nowRef = { ms: day1.startMs + 3_600_000 };
  t.write('tester1', Array.from({ length: 9 }, (_, i) => sent(day1.startMs + 1000 * (i + 1))));
  const gate = gateFor(t, 'tester1', nowRef);
  assert.equal(gate.check().count, 9);

  const day2 = dayWindow('tester1', '2026-11-04', schedule, BOGOTA);
  nowRef.ms = day2.startMs + 3_600_000;
  const next = gate.check();
  assert.equal(next.dateKey, '2026-11-04');
  assert.equal(next.count, 0);
  t.cleanup();
});

test('the age and incidents feed the cap (an incident drops one level)', () => {
  const t = tempResults();
  const window = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  const nowRef = { ms: window.startMs + 3_600_000 };
  const age = { days: 5, incidents: 0 };
  const gate = gateFor(t, 'tester1', nowRef, { getAge: () => age });
  const base = gate.check();
  assert.equal(base.baseCap, 40);
  age.incidents = 2;
  assert.equal(gate.check().baseCap, 20);
  t.cleanup();
});

test('a flat cap (the bot) is used instead of the age-based cap', () => {
  const t = tempResults();
  const window = dayWindow('bot', '2026-11-03', schedule, BOGOTA);
  const nowRef = { ms: window.startMs + 3_600_000 };
  const gate = gateFor(t, 'bot', nowRef, { flatCap: 150, getAge: () => null });
  assert.equal(gate.check().baseCap, 150);
  t.cleanup();
});

test('spreadDelayMs spreads the remaining cap over the remaining window', () => {
  const t = tempResults();
  const window = dayWindow('tester1', '2026-11-03', schedule, BOGOTA);
  const nowRef = { ms: window.startMs + 60_000 };
  const gate = gateFor(t, 'tester1', nowRef);
  const status = gate.check();
  const delay = gate.spreadDelayMs(() => 0.5);
  const expected = (window.endMs - nowRef.ms) / status.cap;
  assert.ok(Math.abs(delay - expected) < 1);
  t.cleanup();
});

test('a disabled schedule never blocks and never spreads', () => {
  const t = tempResults();
  const nowRef = { ms: Date.UTC(2026, 10, 3, 8, 0) };
  const gate = gateFor(t, 'tester1', nowRef, { schedule: normalizeSchedule({ enabled: false }) });
  assert.equal(gate.check().state, 'active');
  assert.equal(gate.spreadDelayMs(() => 0.5), 0);
  t.cleanup();
});

test('an unreadable activity log counts as zero instead of throwing', () => {
  const t = tempResults();
  fs.writeFileSync(path.join(t.dir, 'activity-tester1.jsonl'), 'not json\n{broken\n');
  assert.equal(countSentOnDay({ resultsDir: t.dir, session: 'tester1', dateKey: '2026-11-03', timezone: BOGOTA }), 0);
  t.cleanup();
});
