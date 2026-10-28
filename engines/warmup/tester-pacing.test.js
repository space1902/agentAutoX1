import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLimiter,
  describePaceChange,
  formatPacingTable,
  isManualPacing,
  normalizeAutoPacing,
  paceFromHealth,
  pickPacing,
  recheckDue,
  resolveTesterSettings,
} from './tester-schedule.js';

const GLOBALS = {
  delaySeconds: { min: 20, max: 60 },
  maxMessagesPerTesterPerHour: 40,
};

const HOUR = 60 * 60 * 1000;
const DEFAULTS = { delaySeconds: { min: 20, max: 60 }, maxPerHour: 40 };
const PHASE1 = { delaySeconds: { min: 240, max: 480 }, maxPerHour: 8 };
const PHASE2 = { delaySeconds: { min: 120, max: 240 }, maxPerHour: 20 };

const account = (over = {}) => ({
  session: 'tester1',
  days: 20,
  phase: { phase: 3, name: 'Stable' },
  bidirectional: 1,
  incidents: { total: 0 },
  ...over,
});

const pick = (pace) => ({ delaySeconds: pace.delaySeconds, maxPerHour: pace.maxPerHour });

test('paceFromHealth: phase 1 uses 8/h and 240-480s', () => {
  const pace = paceFromHealth(account({ days: 2, phase: { phase: 1, name: 'Fragile' } }), DEFAULTS);
  assert.deepEqual(pick(pace), PHASE1);
  assert.equal(pace.level, 1);
});

test('paceFromHealth: phase 2 uses 20/h and 120-240s', () => {
  const pace = paceFromHealth(account({ days: 6, phase: { phase: 2, name: 'Growing' } }), DEFAULTS);
  assert.deepEqual(pick(pace), PHASE2);
});

test('paceFromHealth: phase 3 uses the global values and a readable reason', () => {
  const pace = paceFromHealth(account(), DEFAULTS);
  assert.deepEqual(pick(pace), DEFAULTS);
  assert.equal(pace.reason, 'phase 3 stable, 0 incidents, bidir 100% -> 40/h, 20-60s');
});

test('paceFromHealth: phase falls back to days when account.phase is missing', () => {
  const pace = paceFromHealth(account({ phase: undefined, days: 5 }), DEFAULTS);
  assert.deepEqual(pick(pace), PHASE2);
});

test('paceFromHealth: incidents downgrade phase 3 to phase 2 values', () => {
  const pace = paceFromHealth(account({ incidents: { total: 1 } }), DEFAULTS);
  assert.deepEqual(pick(pace), PHASE2);
  assert.match(pace.reason, /downgraded/);
  assert.match(pace.reason, /1 incident/);
});

test('paceFromHealth: downgrade moves phase 2 to phase 1 values', () => {
  const pace = paceFromHealth(
    account({ days: 6, phase: { phase: 2, name: 'Growing' }, incidents: { total: 2 } }),
    DEFAULTS,
  );
  assert.deepEqual(pick(pace), PHASE1);
});

test('paceFromHealth: downgrading phase 1 keeps its delay and halves the cap', () => {
  const pace = paceFromHealth(
    account({ days: 1, phase: { phase: 1, name: 'Fragile' }, incidents: { total: 1 } }),
    DEFAULTS,
  );
  assert.deepEqual(pace.delaySeconds, PHASE1.delaySeconds);
  assert.equal(pace.maxPerHour, 4);
});

test('paceFromHealth: bidirectional ratio below 0.5 downgrades; 0.5 and null do not', () => {
  assert.deepEqual(pick(paceFromHealth(account({ bidirectional: 0.49 }), DEFAULTS)), PHASE2);
  assert.deepEqual(pick(paceFromHealth(account({ bidirectional: 0.5 }), DEFAULTS)), DEFAULTS);
  assert.deepEqual(pick(paceFromHealth(account({ bidirectional: null }), DEFAULTS)), DEFAULTS);
});

test('paceFromHealth: a bidirectional drop of 5+ points vs the previous run downgrades', () => {
  const drop = (delta) => ({ bidirectional: { delta } });
  assert.deepEqual(pick(paceFromHealth(account(), DEFAULTS, { trend: drop(-0.05) })), PHASE2);
  assert.deepEqual(pick(paceFromHealth(account(), DEFAULTS, { trend: drop(-0.2) })), PHASE2);
  assert.deepEqual(pick(paceFromHealth(account(), DEFAULTS, { trend: drop(-0.04) })), DEFAULTS);
  assert.deepEqual(pick(paceFromHealth(account(), DEFAULTS, { trend: drop(0.1) })), DEFAULTS);
  assert.deepEqual(pick(paceFromHealth(account(), DEFAULTS, { trend: drop(null) })), DEFAULTS);
});

test('paceFromHealth: several triggers still downgrade only one level', () => {
  const pace = paceFromHealth(
    account({ incidents: { total: 3 }, bidirectional: 0.1 }),
    DEFAULTS,
    { trend: { bidirectional: { delta: -0.5 } } },
  );
  assert.deepEqual(pick(pace), PHASE2);
});

test('paceFromHealth: failed analysis falls back to phase 1 and says why', () => {
  const pace = paceFromHealth({ session: 'tester2', error: 'Listing chats timed out' }, DEFAULTS);
  assert.deepEqual(pick(pace), PHASE1);
  assert.match(pace.reason, /analysis failed/);
  assert.match(pace.reason, /Listing chats timed out/);
  assert.deepEqual(pick(paceFromHealth(null, DEFAULTS)), PHASE1);
});

test('paceFromHealth: does not share or mutate the defaults', () => {
  const defaults = { delaySeconds: { min: 20, max: 60 }, maxPerHour: 40 };
  const pace = paceFromHealth(account(), defaults);
  pace.delaySeconds.min = 999;
  assert.equal(defaults.delaySeconds.min, 20);
});

test('isManualPacing: only object entries with a pacing field are manual', () => {
  assert.equal(isManualPacing('tester1'), false);
  assert.equal(isManualPacing({ id: 'tester1' }), false);
  assert.equal(isManualPacing({ id: 'tester1', delaySeconds: { min: 1, max: 2 } }), true);
  assert.equal(isManualPacing({ id: 'tester1', maxMessagesPerHour: 5 }), true);
  assert.equal(isManualPacing(null), false);
});

test('normalizeAutoPacing: defaults, partial values and invalid input', () => {
  assert.deepEqual(normalizeAutoPacing(undefined), { enabled: true, recheckHours: 6, windowDays: 14 });
  assert.deepEqual(normalizeAutoPacing({ enabled: false }), {
    enabled: false,
    recheckHours: 6,
    windowDays: 14,
  });
  assert.deepEqual(normalizeAutoPacing({ recheckHours: 2, windowDays: 7 }), {
    enabled: true,
    recheckHours: 2,
    windowDays: 7,
  });
  assert.deepEqual(normalizeAutoPacing({ recheckHours: 0, windowDays: -1 }), {
    enabled: true,
    recheckHours: 6,
    windowDays: 14,
  });
});

test('pickPacing: disabled auto pacing leaves settings untouched', () => {
  const settings = resolveTesterSettings('tester1', GLOBALS);
  const result = pickPacing({
    entry: 'tester1',
    settings,
    autoPacing: { enabled: false },
    account: account(),
  });
  assert.equal(result.mode, 'off');
  assert.deepEqual(result.settings, settings);
});

test('pickPacing: explicit overrides always win over automatic pacing', () => {
  const entry = { id: 'tester3', delaySeconds: { min: 100, max: 200 } };
  const settings = resolveTesterSettings(entry, GLOBALS);
  const result = pickPacing({
    entry,
    settings,
    autoPacing: { enabled: true },
    account: account({ incidents: { total: 5 } }),
  });
  assert.equal(result.mode, 'manual');
  assert.deepEqual(result.settings, settings);
  assert.match(result.reason, /manual/);
});

test('pickPacing: auto mode keeps the id and applies the health pace', () => {
  const settings = resolveTesterSettings('tester1', GLOBALS);
  const result = pickPacing({
    entry: 'tester1',
    settings,
    autoPacing: { enabled: true },
    account: account({ days: 2, phase: { phase: 1, name: 'Fragile' } }),
  });
  assert.equal(result.mode, 'auto');
  assert.deepEqual(result.settings, { id: 'tester1', ...PHASE1 });
  assert.match(result.reason, /phase 1/);
});

test('pickPacing: phase 3 uses the global values', () => {
  const settings = resolveTesterSettings({ id: 'tester1' }, GLOBALS);
  const result = pickPacing({
    entry: { id: 'tester1' },
    settings,
    autoPacing: { enabled: true },
    account: account(),
    defaults: DEFAULTS,
  });
  assert.deepEqual(result.settings, {
    id: 'tester1',
    delaySeconds: { min: 20, max: 60 },
    maxPerHour: 40,
  });
});

test('recheckDue: due once recheckHours have elapsed', () => {
  const t0 = 1_000_000;
  assert.equal(recheckDue(t0, t0 + 6 * HOUR - 1, 6), false);
  assert.equal(recheckDue(t0, t0 + 6 * HOUR, 6), true);
  assert.equal(recheckDue(null, t0, 6), true);
});

test('recheckDue: a failed analysis is retried within one hour', () => {
  const t0 = 1_000_000;
  assert.equal(recheckDue(t0, t0 + HOUR - 1, 6, true), false);
  assert.equal(recheckDue(t0, t0 + HOUR, 6, true), true);
  assert.equal(recheckDue(t0, t0 + 20 * 60_000, 0.25, true), true);
});

test('describePaceChange: null when unchanged, readable line when changed', () => {
  const before = { delaySeconds: { min: 240, max: 480 }, maxPerHour: 8 };
  assert.equal(describePaceChange('tester3', before, { ...before }, 'x'), null);
  const line = describePaceChange('tester3', before, PHASE2, 'reached phase 2');
  assert.equal(line, 'tester3 pace 8/h (240-480s) -> 20/h (120-240s): reached phase 2');
});

test('formatPacingTable: one row per tester with pace and reason', () => {
  const text = formatPacingTable([
    {
      id: 'tester1',
      number: '573001112233',
      phase: 2,
      bidirectional: 0.75,
      incidents: 0,
      settings: { delaySeconds: { min: 120, max: 240 }, maxPerHour: 20 },
      reason: 'phase 2 growing',
    },
    {
      id: 'tester2',
      number: null,
      phase: null,
      bidirectional: null,
      incidents: null,
      settings: { delaySeconds: { min: 240, max: 480 }, maxPerHour: 8 },
      reason: 'analysis failed',
    },
  ]);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /tester.*number.*phase.*bidir.*incidents.*pace.*reason/i);
  assert.match(lines[1], /tester1.*\+573001112233.*2.*75%.*0.*20\/h, 120-240s.*phase 2 growing/);
  assert.match(lines[2], /tester2.*-.*8\/h, 240-480s.*analysis failed/);
});

test('paceFromHealth: a report fallback keeps the real pace and says why', () => {
  const pace = paceFromHealth(
    account({ fallbackFrom: '2026-10-13T19:27:29.493Z', fallbackError: 'Listing chats timed out after 120s' }),
    DEFAULTS,
  );
  assert.deepEqual(pick(pace), DEFAULTS);
  assert.equal(pace.fallback, false);
  assert.match(pace.reason, /^analysis failed \(Listing chats timed out after 120s\); using last report from 2026-10-13/);
  assert.match(pace.reason, /phase 3 stable/);
});

test('createLimiter: never runs more than `max` tasks at once and runs them all', async () => {
  const limit = createLimiter(3);
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 9 }, (_, i) =>
    limit(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return i;
    }),
  );
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(peak, 3);
});

test('createLimiter: a failing task frees its slot and does not block the others', async () => {
  const limit = createLimiter(1);
  const first = limit(async () => {
    throw new Error('boom');
  });
  const second = limit(async () => 'ok');
  await assert.rejects(first, /boom/);
  assert.equal(await second, 'ok');
});

test('createLimiter: invalid max falls back to 1', async () => {
  const limit = createLimiter(0);
  let running = 0;
  let peak = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
      }),
    ),
  );
  assert.equal(peak, 1);
});
