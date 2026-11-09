// Hour-of-day window: parsing, membership (including ranges that wrap midnight) and its effect on the report.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import { HoursError, hourOfRegistered, inHours, parseHoursArg } from './hours.js';
import { buildReport } from './report.js';

const NO_VAT = { ...DEFAULT_CONFIG, spendVatPct: 0 };

test('parseHoursArg: empty or 0-24 means the whole day; bad values are refused', () => {
  assert.equal(parseHoursArg(undefined), null);
  assert.equal(parseHoursArg(true), null);
  assert.equal(parseHoursArg(''), null);
  assert.equal(parseHoursArg('0-24'), null);
  assert.deepEqual(parseHoursArg('8-14'), { start: 8, end: 14 });
  assert.deepEqual(parseHoursArg('22-6'), { start: 22, end: 6 });
  assert.deepEqual(parseHoursArg('22-0'), { start: 22, end: 0 });
  for (const bad of ['8', '8-', 'a-b', '-1-5', '24-5', '5-25', '8-8', '8-14; calc', '1.5-3']) assert.throws(() => parseHoursArg(bad), HoursError, bad);
});

test('hourOfRegistered reads the hour of the sheet timestamp (24 h, also AM/PM and ISO)', () => {
  assert.equal(hourOfRegistered('28/10/2026 11:05:09'), 11);
  assert.equal(hourOfRegistered('1/2/2026 0:00:00'), 0);
  assert.equal(hourOfRegistered('1/2/2026 23:59:59'), 23);
  assert.equal(hourOfRegistered('2026-10-28 10:00'), 10);
  assert.equal(hourOfRegistered('28/10/2026 1:05:09 p. m.'), 13);
  assert.equal(hourOfRegistered('28/10/2026 12:05:09 a. m.'), 0);
  assert.equal(hourOfRegistered('28/10/2026'), null);
  assert.equal(hourOfRegistered(''), null);
  assert.equal(hourOfRegistered('28/10/2026 25:00:00'), null);
});

test('inHours: start inclusive, end exclusive, wrapping past midnight', () => {
  const day = { start: 8, end: 14 };
  assert.deepEqual([7, 8, 13, 14].map((h) => inHours(h, day)), [false, true, true, false]);
  const night = { start: 22, end: 6 };
  assert.deepEqual([21, 22, 23, 0, 5, 6].map((h) => inHours(h, night)), [false, true, true, true, true, false]);
  assert.equal(inHours(3, null), true);
  assert.equal(inHours(null, null), true, 'no window counts everything, even without a time');
  assert.equal(inHours(null, day), false, 'a payment without a time is outside a restricted window');
});

const ins = (gasto, mensajes) => ({ date: '2026-10-28', adId: 'A', adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's', adsetName: 'S', gasto, mensajes, country: '' });
const pay = (hhmm, n, valor) => ({
  key: `k${n}`, registered: `28/10/2026 ${hhmm}:00`, date: '2026-10-28', result: 'Pago válido', phone: `57300000000${n}`, valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '',
});
const identities = { A: { adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas' } };
const comprobantes = [pay('07:30', 1, 10000), pay('09:15', 2, 20000), pay('13:59', 3, 30000), pay('14:00', 4, 40000), pay('23:10', 5, 50000), pay('02:00', 6, 60000)];
const run = (hours) => buildReport({ insights: [ins(30000, 20)], comprobantes, identities, config: NO_VAT, from: '2026-10-28', to: '2026-10-28', today: '2026-10-29', hours });

test('without a window every sale counts and the hourly chart still lists the 24 hours', () => {
  const r = run(undefined);
  assert.equal(r.kpis.ventas, 6);
  assert.equal(r.kpis.valor, 210000);
  assert.equal(r.hours.restricted, false);
  assert.equal(r.hourly.length, 24);
  assert.equal(r.hourly[9].ventas, 1);
  assert.equal(r.hourly[13].valor, 30000);
  assert.equal(r.hourly.reduce((n, h) => n + h.ventas, 0), 6);
});

test('without hourly spend a window falls back to the whole-day spend (and says so) and counts only the sales inside it', () => {
  const r = run({ start: 8, end: 14 });
  assert.equal(r.kpis.ventas, 2);
  assert.equal(r.kpis.valor, 50000);
  assert.equal(r.kpis.gasto, 30000);
  for (const x of [r.kpis, r.rows[0], r.countries[0], r.daily[0]]) assert.equal(x.mensajes, null, 'messages are N/D with a window, never 0');
  assert.equal(r.kpis.costoMensaje, null);
  assert.equal(r.kpis.conversion, null);
  assert.equal(run(undefined).kpis.mensajes, 20, 'without a window messages are unchanged');
  assert.equal(r.kpis.roas, 50000 / 30000);
  assert.equal(r.notes.find((n) => n.code === 'hourly_spend_missing')?.count, 1);
  assert.deepEqual(r.hours, { start: 8, end: 14, restricted: true });
  assert.equal(r.rows[0].ventas, 2);
  assert.equal(r.daily[0].ventas, 2);
  assert.equal(r.hourly.reduce((n, h) => n + h.ventas, 0), 6, 'the chart shows every hour, the window only highlights');
  assert.equal(r.comprobantes.length, 6, 'the vouchers list is not filtered by the window');
});

test('a window that wraps midnight counts the late and early sales', () => {
  const r = run({ start: 22, end: 6 });
  assert.equal(r.kpis.ventas, 2);
  assert.equal(r.kpis.valor, 110000);
});

test('with a window the rows carry no suggested action (whole-day spend would make it misleading); without one they do', () => {
  assert.ok(run(undefined).rows[0].action);
  for (const h of [{ start: 8, end: 14 }, { start: 22, end: 6 }]) {
    const r = run(h);
    assert.equal(r.rows[0].action, null);
    assert.equal(r.rows[0].suggestedAction, null);
  }
});
