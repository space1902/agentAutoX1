import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localParts, inHourRange, addDays } from './time.js';

const TZ = 'America/Bogota';

test('localParts uses the account timezone, not the machine one', () => {
  const p = localParts(Date.parse('2026-10-25T12:30:00Z'), TZ);
  assert.deepEqual(p, { date: '2026-10-25', hour: 7, minute: 30, minutesOfDay: 450 });
});

test('localParts rolls the date back across midnight', () => {
  const p = localParts(Date.parse('2026-10-25T03:10:00Z'), TZ);
  assert.equal(p.date, '2026-10-24');
  assert.equal(p.hour, 22);
});

test('inHourRange handles normal and wrapping ranges', () => {
  assert.equal(inHourRange(7, { start: 7, end: 23 }), true);
  assert.equal(inHourRange(22, { start: 7, end: 23 }), true);
  assert.equal(inHourRange(23, { start: 7, end: 23 }), false);
  assert.equal(inHourRange(3, { start: 7, end: 23 }), false);
  assert.equal(inHourRange(23, { start: 22, end: 6 }), true);
  assert.equal(inHourRange(2, { start: 22, end: 6 }), true);
  assert.equal(inHourRange(12, { start: 22, end: 6 }), false);
});

test('addDays works on date strings', () => {
  assert.equal(addDays('2026-10-25', -5), '2026-10-20');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
