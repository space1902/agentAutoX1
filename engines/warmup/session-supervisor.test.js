import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BRAKE, createDisconnectTracker } from './disconnect-brake.js';
import { createPauseStore } from './pause-state.js';
import { createSupervisor } from './session-supervisor.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 3, 15, 0, 0);

function setup({ fleet = 10 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
  const clock = { ms: T0 };
  const warnings = [];
  const events = [];
  const stopped = [];
  const timers = [];
  const store = createPauseStore({ file: path.join(dir, 'warmup-pauses.json'), now: () => clock.ms, warn: (m) => warnings.push(m) });
  const supervisor = createSupervisor({
    store,
    tracker: createDisconnectTracker(),
    now: () => clock.ms,
    fleetSize: () => fleet,
    logEvent: (session, event, detail) => events.push({ session, event, detail }),
    stopSession: (session) => stopped.push(session),
    numberOf: (session) => `57300000${session.replace(/\D/g, '').padStart(4, '0')}`,
    warn: (m) => warnings.push(m),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { dir, clock, warnings, events, stopped, timers, store, supervisor, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a logout pauses the number persistently, stops its socket and logs a paused event', () => {
  const t = setup();
  t.supervisor.onLoggedOut('tester3');

  const pause = t.store.get('tester3');
  assert.equal(pause.reason, 'logged_out');
  assert.equal(pause.source, 'engine');
  assert.equal(pause.until, null);
  assert.deepEqual(t.stopped, ['tester3']);
  assert.equal(t.events.length, 1);
  assert.equal(t.events[0].event, 'paused');
  assert.match(t.events[0].detail, /logged_out/);
  t.cleanup();
});

test('a logout while already paused is not logged twice', () => {
  const t = setup();
  t.supervisor.onLoggedOut('tester3');
  t.supervisor.onLoggedOut('tester3');
  assert.equal(t.events.filter((e) => e.event === 'paused').length, 1);
  t.cleanup();
});

test('repeated disconnects pause the number for 6 h after the settle delay, not before', () => {
  const t = setup();
  for (let i = 0; i < 5; i++) {
    t.clock.ms = T0 + i * 5 * MIN;
    t.supervisor.onDisconnect('tester1', '408');
  }
  assert.equal(t.store.get('tester1'), null, 'nothing yet: the burst has not settled');
  assert.ok(t.timers.length > 0, 'a re-check is scheduled after the settle delay');
  assert.ok(t.timers.every((x) => x.ms > BRAKE.settleMs));

  t.supervisor.sweep();
  assert.equal(t.store.get('tester1'), null);

  t.clock.ms += BRAKE.settleMs + 5000;
  t.supervisor.sweep();
  const pause = t.store.get('tester1');
  assert.equal(pause.reason, 'repeated_disconnects');
  assert.equal(new Date(pause.until).getTime() - new Date(pause.since).getTime(), 6 * HOUR);
  assert.deepEqual(t.stopped, ['tester1']);
  assert.equal(t.events.at(-1).event, 'paused');
  t.cleanup();
});

test('a repeat brake pause doubles the time', () => {
  const t = setup();
  const burst = () => {
    for (let i = 0; i < 5; i++) {
      t.clock.ms += 5 * MIN;
      t.supervisor.onDisconnect('tester1', '408');
    }
    t.clock.ms += BRAKE.settleMs + 5000;
    t.supervisor.sweep();
  };
  burst();
  const first = t.store.get('tester1');
  assert.equal(new Date(first.until) - new Date(first.since), 6 * HOUR);

  t.store.resume('tester1');
  burst();
  const second = t.store.get('tester1');
  assert.equal(new Date(second.until) - new Date(second.since), 12 * HOUR);
  t.cleanup();
});

test('a PC crash or network drop (60%+ of the numbers at once) pauses nobody', () => {
  const t = setup({ fleet: 10 });
  for (let round = 0; round < 6; round++) {
    for (let n = 1; n <= 8; n++) {
      t.clock.ms = T0 + round * 8 * MIN + n * 2000;
      t.supervisor.onDisconnect(`tester${n}`, '408');
    }
  }
  t.clock.ms += BRAKE.settleMs + 5000;
  t.supervisor.sweep();
  assert.deepEqual(t.store.list(), []);
  assert.deepEqual(t.stopped, []);
  assert.deepEqual(t.events.filter((e) => e.event === 'paused'), []);
  t.cleanup();
});

test('disconnects right after the session started (restart reconnects) do not count', () => {
  const t = setup();
  t.supervisor.markStarted('tester1');
  for (let i = 0; i < 8; i++) {
    t.clock.ms = T0 + 5000 + i * 10_000;
    t.supervisor.onDisconnect('tester1', '503');
  }
  t.clock.ms += 10 * MIN;
  t.supervisor.sweep();
  assert.equal(t.store.get('tester1'), null);
  t.cleanup();
});

test('a long gap between heartbeats (the PC was asleep) exempts the disconnects that follow', () => {
  const t = setup();
  t.supervisor.beat();
  for (let i = 0; i < 6; i++) {
    // The machine wakes up and every socket reports its close; the loop was frozen for ages.
    t.clock.ms = T0 + 20 * MIN + i * 1000;
    t.supervisor.onDisconnect('tester1', '408');
  }
  t.clock.ms += 10 * MIN;
  t.supervisor.sweep();
  assert.equal(t.store.get('tester1'), null);
  t.cleanup();
});

test('regular heartbeats do not exempt anything', () => {
  const t = setup();
  for (let i = 0; i < 5; i++) {
    t.clock.ms = T0 + i * 5 * MIN;
    t.supervisor.beat();
    t.clock.ms += 5000;
    t.supervisor.onDisconnect('tester1', '408');
  }
  t.clock.ms += BRAKE.settleMs + 5000;
  t.supervisor.sweep();
  assert.ok(t.store.get('tester1'));
  t.cleanup();
});

test('sweep() ends finished timed pauses and logs a resumed event', () => {
  const t = setup();
  t.supervisor.pauseSession('tester1', { reason: 'repeated_disconnects', source: 'engine', durationMs: 6 * HOUR, detail: 'x', countStrike: true });
  t.clock.ms += 7 * HOUR;
  t.supervisor.sweep();
  assert.equal(t.store.get('tester1'), null);
  const resumed = t.events.filter((e) => e.event === 'resumed');
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].detail, /expired/);
  t.cleanup();
});

test('resumeSession clears a pause, logs it, and forgets earlier disconnects', () => {
  const t = setup();
  t.supervisor.pauseSession('tester1', { reason: 'manual', source: 'user', durationMs: null });
  assert.equal(t.supervisor.resumeSession('tester1', 'user'), true);
  assert.equal(t.store.get('tester1'), null);
  assert.equal(t.events.at(-1).event, 'resumed');
  assert.equal(t.supervisor.resumeSession('tester1', 'user'), false);
  t.cleanup();
});

test('a corrupt pause file does not break the supervisor', () => {
  const t = setup();
  fs.writeFileSync(t.store.file, '{broken');
  assert.doesNotThrow(() => t.supervisor.onLoggedOut('tester2'));
  assert.ok(t.store.get('tester2'));
  assert.ok(t.warnings.length >= 1);
  t.cleanup();
});

test('the paused event is not an incident: health counting ignores it', async () => {
  const { summarizeIncidents } = await import('./health-metrics.js');
  const t = setup();
  t.supervisor.onLoggedOut('tester3');
  const events = t.events.map((e, i) => ({ at: new Date(T0 + i).toISOString(), session: e.session, event: e.event, detail: e.detail }));
  events.push({ at: new Date(T0).toISOString(), session: 'tester3', event: 'disconnected', detail: 'LOGOUT' });
  const summary = summarizeIncidents(events, 'tester3', new Date(T0 - HOUR));
  assert.equal(summary.total, 1, 'only the disconnect counts; the pause is not a second incident');
  t.cleanup();
});
