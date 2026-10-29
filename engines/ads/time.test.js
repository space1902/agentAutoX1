import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addDays, chunkRange, daysBetween, eachDate, isIsoDate, localParts } from './time.js';

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('daysBetween and eachDate are inclusive-aware', () => {
  assert.equal(daysBetween('2026-10-25', '2026-10-29'), 4);
  assert.deepEqual(eachDate('2026-10-28', '2026-10-30'), ['2026-10-28', '2026-10-29', '2026-10-30']);
  assert.deepEqual(eachDate('2026-10-30', '2026-10-28'), []);
});

test('chunkRange splits long ranges', () => {
  assert.deepEqual(chunkRange('2026-10-01', '2026-10-10', 31), [{ since: '2026-10-01', until: '2026-10-10' }]);
  const chunks = chunkRange('2026-09-01', '2026-10-15', 31);
  assert.deepEqual(chunks, [{ since: '2026-09-01', until: '2026-10-01' }, { since: '2026-10-02', until: '2026-10-15' }]);
});

test('localParts uses the account timezone, not the machine one', () => {
  // 2026-10-29T03:30Z is still Oct 28 22:30 in Bogota (UTC-5).
  const p = localParts(Date.parse('2026-10-29T03:30:00Z'), 'America/Bogota');
  assert.equal(p.date, '2026-10-28');
  assert.equal(p.hour, 22);
});

test('isIsoDate validates shape and calendar', () => {
  assert.equal(isIsoDate('2026-10-29'), true);
  assert.equal(isIsoDate('2026-13-29'), false);
  assert.equal(isIsoDate('29/10/2026'), false);
  assert.equal(isIsoDate('2026-10-29; rm'), false);
});
