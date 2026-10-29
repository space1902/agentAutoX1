import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSales, seedSalesFromHourly } from './sales.js';

const NOW = Date.parse('2026-10-25T20:00:00Z'); // 15:00 Bogota
const TZ = 'America/Bogota';

test('detectSales diffs cumulative purchases per ad', () => {
  const prev = { a1: 1, a2: 0 };
  const ads = [
    { id: 'a1', purchases: 3, spend: 4000 },
    { id: 'a2', purchases: 0, spend: 100 },
    { id: 'a3', purchases: 1, spend: 800 },
  ];
  const events = detectSales(prev, ads, NOW);
  assert.deepEqual(events, [
    { adId: 'a1', count: 2, spendAt: 4000, ts: NOW },
    { adId: 'a3', count: 1, spendAt: 800, ts: NOW },
  ]);
});

test('detectSales ignores decreases (attribution adjustments) and unknown history', () => {
  assert.deepEqual(detectSales({ a1: 5 }, [{ id: 'a1', purchases: 3, spend: 1 }], NOW), []);
  assert.deepEqual(detectSales(null, [{ id: 'a1', purchases: 3, spend: 1 }], NOW), []);
});

test('seedSalesFromHourly places the last sale of each ad at the end of its hour', () => {
  const rows = [
    { date: '2026-10-25', hour: 8, adId: 'a1', spend: 1000, purchases: 1 },
    { date: '2026-10-25', hour: 9, adId: 'a1', spend: 500, purchases: 0 },
    { date: '2026-10-25', hour: 10, adId: 'a1', spend: 700, purchases: 2 },
    { date: '2026-10-25', hour: 11, adId: 'a1', spend: 900, purchases: 0 },
    { date: '2026-10-25', hour: 15, adId: 'a2', spend: 300, purchases: 1 },
    { date: '2026-10-24', hour: 12, adId: 'a1', spend: 999, purchases: 9 },
  ];
  const events = seedSalesFromHourly(rows, { nowMs: NOW, tz: TZ });
  const a1 = events.find((e) => e.adId === 'a1');
  assert.equal(a1.spendAt, 1000 + 500 + 700);
  assert.equal(a1.count, 3);
  assert.equal(a1.ts, Date.parse('2026-10-25T15:59:00Z')); // 10:59 Bogota
  const a2 = events.find((e) => e.adId === 'a2');
  assert.equal(a2.ts, NOW, 'current hour is clamped to now');
});

test('seedSalesFromHourly returns nothing without sales today', () => {
  assert.deepEqual(seedSalesFromHourly([{ date: '2026-10-25', hour: 8, adId: 'a1', spend: 1, purchases: 0 }], { nowMs: NOW, tz: TZ }), []);
});
