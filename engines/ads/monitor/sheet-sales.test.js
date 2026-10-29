import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UNATTRIBUTED, mergeHourlyPurchases, registeredParts, todaySales, hourlySales } from './sheet-sales.js';
import { seedSalesFromHourly } from './sales.js';

const cfg = { flowPrefix: 'Bebidas', validResult: 'Pago válido' };
const row = (registered, adId, extra = {}) => ({ registered, date: registered.slice(0, 10), result: 'Pago válido', flow: 'Bebidas - aporte', adId, valor: 15000, ...extra });
// Rows as the sheet parser returns them: `date` is the voucher date, `registered` the moment the payment arrived.
const rows = [
  row('28/10/2026 10:05:00', 'A'),
  row('28/10/2026 10:40:00', 'A'),
  row('28/10/2026 11:15:00', 'B'),
  row('28/10/2026 11:20:00', ''),
  row('28/10/2026 11:30:00', 'A', { result: 'Comprobante inválido' }),
  row('28/10/2026 11:31:00', 'A', { flow: 'Barf Whats' }),
  row('27/10/2026 23:50:00', 'A'),
];

test('registeredParts reads the day and the minute of the day from "Registrado el"', () => {
  assert.deepEqual(registeredParts('1/10/2026 0:01:13'), { date: '2026-10-01', hour: 0, minutes: 1 });
  assert.deepEqual(registeredParts('28/10/2026 23:59'), { date: '2026-10-28', hour: 23, minutes: 1439 });
  assert.equal(registeredParts('nonsense'), null);
  assert.deepEqual(registeredParts('28/10/2026'), { date: '2026-10-28', hour: null, minutes: null });
});

test('todaySales counts only valid payments of the flow registered today, per ad', () => {
  const t = todaySales(rows, { today: '2026-10-28', ...cfg });
  assert.equal(t.byAd.A, 2);
  assert.equal(t.byAd.B, 1);
  assert.equal(t.unattributed, 1);
  assert.equal(t.total, 4);
  assert.equal(t.lastMinutes, 11 * 60 + 20);
});

test('hourlySales buckets by date, hour and ad (unattributed has its own key)', () => {
  const h = hourlySales(rows, { from: '2026-10-27', to: '2026-10-28', ...cfg });
  assert.equal(h.get('2026-10-28|10|A'), 2);
  assert.equal(h.get(`2026-10-28|11|${UNATTRIBUTED}`), 1);
  assert.equal(h.get('2026-10-27|23|A'), 1);
  assert.equal(h.size, 4);
});

const meta = (date, hour, adId, purchases, spend = 100) => ({ date, hour, adId, adName: `Ad ${adId}`, spend, impressions: 1000, clicks: 10, purchases, conversations: 5 });

test('mergeHourlyPurchases: sheet replaces Meta purchases and adds hours Meta never saw', () => {
  const hourly = hourlySales(rows, { from: '2026-10-28', to: '2026-10-28', ...cfg });
  const out = mergeHourlyPurchases([meta('2026-10-28', 10, 'A', 5), meta('2026-10-28', 12, 'A', 3)], hourly, 'sheet');
  const get = (hour, id) => out.filter((r) => r.hour === hour && r.adId === id).reduce((s, r) => s + r.purchases, 0);
  assert.equal(get(10, 'A'), 2);
  assert.equal(get(12, 'A'), 0);
  assert.equal(get(11, 'B'), 1, 'sheet-only hour is added');
  assert.equal(get(11, UNATTRIBUTED), 1);
});

test('mergeHourlyPurchases: meta source is untouched and "both" keeps the larger count', () => {
  const hourly = hourlySales(rows, { from: '2026-10-28', to: '2026-10-28', ...cfg });
  const base = [meta('2026-10-28', 10, 'A', 5)];
  assert.deepEqual(mergeHourlyPurchases(base, hourly, 'meta'), base);
  const both = mergeHourlyPurchases(base, hourly, 'both');
  assert.equal(both.find((r) => r.hour === 10 && r.adId === 'A').purchases, 5);
  assert.equal(mergeHourlyPurchases([meta('2026-10-28', 10, 'A', 1)], hourly, 'both').find((r) => r.hour === 10).purchases, 2);
});

test('the merged rows seed "last sale" per ad from the sheet after a restart', () => {
  const hourly = hourlySales(rows, { from: '2026-10-28', to: '2026-10-28', ...cfg });
  const merged = mergeHourlyPurchases([meta('2026-10-28', 10, 'A', 0, 300), meta('2026-10-28', 12, 'A', 0, 200)], hourly, 'sheet');
  const nowMs = Date.parse('2026-10-28T20:00:00Z'); // 15:00 in Bogota
  const events = seedSalesFromHourly(merged, { nowMs, tz: 'America/Bogota' });
  const a = events.find((e) => e.adId === 'A');
  assert.equal(a.count, 2);
  assert.equal(a.spendAt, 300, 'spend up to the last selling hour');
});
