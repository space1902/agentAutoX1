import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BRAKE_PAUSE,
  activePause,
  brakeDurationMs,
  createPauseStore,
  emptyState,
  loadPauseState,
  savePauseState,
  withPause,
  withoutPause,
} from './pause-state.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 15, 0, 0);

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-state-'));
  return { dir, file: path.join(dir, 'warmup-pauses.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('loadPauseState: a missing file is an empty state and no warning', () => {
  const t = tempFile();
  const warnings = [];
  const result = loadPauseState(t.file, { warn: (m) => warnings.push(m) });
  assert.deepEqual(result.state, emptyState());
  assert.equal(result.corrupt, false);
  assert.deepEqual(warnings, []);
  t.cleanup();
});

test('loadPauseState: a corrupt file never throws, warns, and is reported as corrupt', () => {
  const t = tempFile();
  const warnings = [];
  for (const garbage of ['{not json', '', '[]', 'null', '"text"', '{"paused": 7}']) {
    fs.writeFileSync(t.file, garbage);
    const result = loadPauseState(t.file, { warn: (m) => warnings.push(m) });
    assert.deepEqual(result.state.paused, {}, `garbage: ${garbage}`);
  }
  assert.ok(warnings.length >= 4);
  fs.writeFileSync(t.file, '{not json');
  assert.equal(loadPauseState(t.file, { warn: () => {} }).corrupt, true);
  t.cleanup();
});

test('loadPauseState: drops malformed entries but keeps the valid ones', () => {
  const t = tempFile();
  fs.writeFileSync(
    t.file,
    JSON.stringify({
      version: 1,
      paused: {
        good: { session: 'good', reason: 'manual', source: 'user', since: '2026-11-03T10:00:00.000Z', until: null },
        weird: { session: 'weird', reason: 'logged_out', source: 'engine', since: 'garbage', until: 'garbage' },
        nothing: 5,
      },
    }),
  );
  const { state } = loadPauseState(t.file, { warn: () => {} });
  assert.ok(state.paused.good);
  assert.equal(state.paused.nothing, undefined);
  // An unreadable date stays paused (fail safe) instead of silently resuming.
  assert.ok(state.paused.weird);
  assert.equal(activePause(state, 'weird', NOW)?.session, 'weird');
  t.cleanup();
});

test('savePauseState: atomic write, creates the folder, leaves no temp file, round-trips', () => {
  const t = tempFile();
  const nested = path.join(t.dir, 'sub', 'warmup-pauses.json');
  const state = withPause(emptyState(), { session: 'tester3', number: '573000000003', reason: 'logged_out', source: 'engine', nowMs: NOW, durationMs: null });
  savePauseState(nested, state);
  assert.deepEqual(fs.readdirSync(path.join(t.dir, 'sub')), ['warmup-pauses.json']);
  const back = loadPauseState(nested, { warn: () => {} }).state;
  assert.equal(back.paused.tester3.reason, 'logged_out');
  assert.equal(back.paused.tester3.number, '573000000003');
  assert.equal(back.paused.tester3.until, null);
  assert.equal(back.paused.tester3.source, 'engine');
  assert.equal(new Date(back.paused.tester3.since).getTime(), NOW);
  t.cleanup();
});

test('activePause: indefinite pauses stay, timed pauses expire', () => {
  let state = withPause(emptyState(), { session: 'a', reason: 'logged_out', source: 'engine', nowMs: NOW, durationMs: null });
  state = withPause(state, { session: 'b', reason: 'repeated_disconnects', source: 'engine', nowMs: NOW, durationMs: 6 * HOUR });
  assert.ok(activePause(state, 'a', NOW + 1000 * HOUR));
  assert.ok(activePause(state, 'b', NOW + 5 * HOUR));
  assert.equal(activePause(state, 'b', NOW + 6 * HOUR), null);
  assert.equal(activePause(state, 'nobody', NOW), null);
  assert.equal(new Date(state.paused.b.until).getTime(), NOW + 6 * HOUR);
});

test('withoutPause removes only that session and is a no-op when absent', () => {
  let state = withPause(emptyState(), { session: 'a', reason: 'manual', source: 'user', nowMs: NOW, durationMs: null });
  state = withPause(state, { session: 'b', reason: 'manual', source: 'user', nowMs: NOW, durationMs: null });
  const next = withoutPause(state, 'a');
  assert.equal(next.paused.a, undefined);
  assert.ok(next.paused.b);
  assert.deepEqual(withoutPause(next, 'zzz'), next);
  assert.ok(state.paused.a, 'the original state is not mutated');
});

test('brakeDurationMs: 6 h first, doubling on repeat, capped at 48 h, forgotten after a quiet week', () => {
  let state = emptyState();
  const durations = [];
  let at = NOW;
  for (let i = 0; i < 6; i++) {
    const { durationMs } = brakeDurationMs(state, 'a', at);
    durations.push(durationMs / HOUR);
    state = withPause(state, { session: 'a', reason: 'repeated_disconnects', source: 'engine', nowMs: at, durationMs, countStrike: true });
    at += durationMs + HOUR;
  }
  assert.deepEqual(durations, [6, 12, 24, 48, 48, 48]);
  assert.equal(BRAKE_PAUSE.baseMs, 6 * HOUR);
  assert.equal(BRAKE_PAUSE.maxMs, 48 * HOUR);

  const lastStrike = new Date(state.strikes.a.last).getTime();
  assert.equal(brakeDurationMs(state, 'a', lastStrike + 8 * 24 * HOUR).durationMs, 6 * HOUR);
  assert.equal(brakeDurationMs(state, 'other', NOW).durationMs, 6 * HOUR);
});

test('a manual or logout pause does not count as a brake strike', () => {
  const state = withPause(emptyState(), { session: 'a', reason: 'manual', source: 'user', nowMs: NOW, durationMs: null });
  assert.equal(state.strikes.a, undefined);
  assert.equal(brakeDurationMs(state, 'a', NOW).durationMs, 6 * HOUR);
});

test('createPauseStore: pause, get, resume persist to disk and survive a new store (restart)', () => {
  const t = tempFile();
  let clock = NOW;
  const store = createPauseStore({ file: t.file, now: () => clock, warn: () => {} });
  assert.equal(store.get('tester1'), null);

  store.pause({ session: 'tester1', number: '573111111111', reason: 'logged_out', source: 'engine', durationMs: null });
  assert.equal(store.get('tester1').reason, 'logged_out');

  const reopened = createPauseStore({ file: t.file, now: () => clock, warn: () => {} });
  assert.equal(reopened.get('tester1').reason, 'logged_out');
  assert.deepEqual(reopened.list().map((e) => e.session), ['tester1']);

  assert.equal(reopened.resume('tester1'), true);
  assert.equal(reopened.resume('tester1'), false);
  assert.equal(createPauseStore({ file: t.file, now: () => clock, warn: () => {} }).get('tester1'), null);
  t.cleanup();
});

test('createPauseStore: sees a change made by another process (the app) without restarting', () => {
  const t = tempFile();
  const engine = createPauseStore({ file: t.file, now: () => NOW, warn: () => {} });
  const app = createPauseStore({ file: t.file, now: () => NOW, warn: () => {} });
  assert.equal(engine.get('tester2'), null);

  app.pause({ session: 'tester2', reason: 'manual', source: 'user', durationMs: null });
  assert.equal(engine.get('tester2')?.reason, 'manual');

  app.resume('tester2');
  assert.equal(engine.get('tester2'), null);
  t.cleanup();
});

test('createPauseStore: expire() removes finished timed pauses and reports them', () => {
  const t = tempFile();
  let clock = NOW;
  const store = createPauseStore({ file: t.file, now: () => clock, warn: () => {} });
  store.pause({ session: 'a', reason: 'repeated_disconnects', source: 'engine', durationMs: 6 * HOUR, countStrike: true });
  store.pause({ session: 'b', reason: 'logged_out', source: 'engine', durationMs: null });
  assert.deepEqual(store.expire(), []);
  clock += 7 * HOUR;
  assert.deepEqual(store.expire(), ['a']);
  assert.equal(store.get('a'), null);
  assert.ok(store.get('b'));
  t.cleanup();
});

test('createPauseStore: a corrupt file does not crash, warns, and the bad file is kept aside when saving', () => {
  const t = tempFile();
  fs.writeFileSync(t.file, '{oops');
  const warnings = [];
  const store = createPauseStore({ file: t.file, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.equal(store.get('x'), null);
  assert.ok(warnings.length >= 1);

  store.pause({ session: 'x', reason: 'manual', source: 'user', durationMs: null });
  assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).paused.x.reason, 'manual');
  const aside = fs.readdirSync(t.dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(t.dir, aside[0]), 'utf8'), '{oops');
  t.cleanup();
});

test('createPauseStore: an unwritable location is reported but never thrown', () => {
  const t = tempFile();
  // A directory where the file should be makes the rename fail.
  fs.mkdirSync(t.file);
  const warnings = [];
  const store = createPauseStore({ file: t.file, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.doesNotThrow(() => store.pause({ session: 'x', reason: 'manual', source: 'user', durationMs: null }));
  assert.ok(warnings.length >= 1);
  // The pause still holds for this process even though it could not be saved.
  assert.ok(store.get('x'));
  t.cleanup();
});

// ---- save retries and strict mode ----

const busy = (code = 'EPERM') => Object.assign(new Error(code), { code });

test('savePauseState retries a rename that Windows refuses for a moment (EPERM/EBUSY)', () => {
  const t = tempFile();
  let calls = 0;
  const rename = (from, to) => {
    calls++;
    if (calls <= 2) throw busy(calls === 1 ? 'EPERM' : 'EBUSY');
    fs.renameSync(from, to);
  };
  savePauseState(t.file, withPause(emptyState(), { session: 'a', reason: 'manual', source: 'user', nowMs: NOW }), { rename, sleep: () => {} });
  assert.equal(calls, 3);
  assert.ok(JSON.parse(fs.readFileSync(t.file, 'utf8')).paused.a);
  assert.deepEqual(fs.readdirSync(t.dir), ['warmup-pauses.json'], 'no temp file left');
  t.cleanup();
});

test('savePauseState gives up after a few tries, cleans the temp file and throws', () => {
  const t = tempFile();
  let calls = 0;
  const rename = () => {
    calls++;
    throw busy();
  };
  assert.throws(() => savePauseState(t.file, emptyState(), { rename, sleep: () => {} }), /EPERM/);
  assert.ok(calls >= 3 && calls <= 10);
  assert.deepEqual(fs.readdirSync(t.dir), []);
  t.cleanup();
});

test('savePauseState does not retry errors that waiting cannot fix', () => {
  const t = tempFile();
  let calls = 0;
  const rename = () => {
    calls++;
    throw busy('ENOSPC');
  };
  assert.throws(() => savePauseState(t.file, emptyState(), { rename, sleep: () => {} }), /ENOSPC/);
  assert.equal(calls, 1);
  t.cleanup();
});

test('a strict store (the app) throws when the pause could not be saved, instead of reporting success', () => {
  const t = tempFile();
  fs.mkdirSync(t.file); // a folder where the file should be: the rename always fails
  const store = createPauseStore({ file: t.file, now: () => NOW, warn: () => {}, strict: true, sleep: () => {} });
  assert.throws(() => store.pause({ session: 'x', reason: 'manual', source: 'user' }), /save/i);
  t.cleanup();
});

test('a strict store re-reads the file right before writing, so the other process change is kept', () => {
  const t = tempFile();
  const app = createPauseStore({ file: t.file, now: () => NOW, warn: () => {}, strict: true });
  const engine = createPauseStore({ file: t.file, now: () => NOW, warn: () => {} });
  assert.equal(app.get('a'), null);
  engine.pause({ session: 'b', reason: 'logged_out', source: 'engine' });
  app.pause({ session: 'a', reason: 'manual', source: 'user' });
  const saved = JSON.parse(fs.readFileSync(t.file, 'utf8')).paused;
  assert.ok(saved.a && saved.b);
  t.cleanup();
});
