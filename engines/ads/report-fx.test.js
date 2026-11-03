import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig } from './config.js';
import { buildReport } from './report.js';

const ins = (date, gasto) => ({ date, adId: 'A', adName: 'Ad A', campaignId: 'cA', campaignName: 'CT01 Col', adsetId: 's', adsetName: 'S', gasto, mensajes: 5, country: 'CO' });
const pay = (date, phone, valor) => ({ key: `${date}-${phone}`, registered: `${date} 10:00`, date, result: 'Pago válido', phone, valor, bank: 'X', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '', country: '', countrySource: '', gone: false });
const identities = { A: { adName: 'Ad A', campaignId: 'cA', campaignName: 'CT01 Col' } };
const fxRates = { MXN: [{ date: '2026-11-01', rate: 100, fetchedAt: 1000, source: 'open.er-api.com' }, { date: '2026-11-02', rate: 110, fetchedAt: 2000, source: 'open.er-api.com' }] };
const config = mergeConfig({ spendVatPct: 0, enabledCountries: ['CO', 'MX'], countries: { MX: { rateToCop: 50 } } });
const comprobantes = [pay('2026-11-01', '525512345678', 10), pay('2026-11-02', '525512345679', 10), pay('2026-10-20', '525512345670', 10)];
const run = (over = {}) => buildReport({ insights: [ins('2026-11-01', 1000)], comprobantes, identities, config, fxRates, from: '2026-10-15', to: '2026-11-02', group: 'campaign', today: '2026-11-03', ...over });

test('each payment is converted with the rate saved for its own day', () => {
  const { kpis, comprobantes: list } = run();
  // 2026-10-20 has no saved rate yet: the earliest known (100) applies.
  assert.equal(kpis.valor, 10 * 100 + 10 * 110 + 10 * 100);
  assert.equal(kpis.valorNative, 30);
  assert.deepEqual(list.map((c) => [c.date, c.valorCop]).sort(), [['2026-10-20', 1000], ['2026-11-01', 1000], ['2026-11-02', 1100]]);
});

test('turning the automatic rate off uses the manual rate for every day', () => {
  const manual = mergeConfig({ spendVatPct: 0, enabledCountries: ['CO', 'MX'], countries: { MX: { rateToCop: 50, autoRate: false } } });
  assert.equal(run({ config: manual }).kpis.valor, 30 * 50);
});

test('without any saved rate the manual rate is the fallback', () => {
  assert.equal(run({ fxRates: {} }).kpis.valor, 30 * 50);
});

test('the report lists every enabled country, with or without data', () => {
  const r = run({ insights: [], comprobantes: [] });
  assert.deepEqual(r.enabledCountries.map((c) => [c.country, c.name, c.currency, c.hasData]), [['CO', 'Colombia', 'COP', false], ['MX', 'México', 'MXN', false]]);
  assert.equal(run({ country: 'MX' }).kpis.ventas, 3);
  const empty = run({ country: 'MX', comprobantes: [] });
  assert.deepEqual([empty.kpis.gasto, empty.kpis.valor, empty.kpis.ventas], [0, 0, 0]);
  assert.equal(run().enabledCountries.find((c) => c.country === 'MX').hasData, true);
});

test('fx info gives the effective rate near the end of the range, its source and fetch time', () => {
  const { fx } = run();
  assert.equal(fx.length, 1);
  assert.deepEqual(
    { ...fx[0] },
    { country: 'MX', currency: 'MXN', mode: 'auto', rate: 110, date: '2026-11-02', fetchedAt: 2000, source: 'open.er-api.com' },
  );
  const manual = run({ fxRates: {} }).fx[0];
  assert.deepEqual([manual.mode, manual.rate, manual.fetchedAt], ['manual', 50, null]);
});

test('the country table carries the effective rate', () => {
  const mx = run().countries.find((c) => c.country === 'MX');
  assert.equal(mx.rateToCop, 110);
  assert.equal(mx.valorNative, 30);
  assert.equal(mx.rateMissing, false);
});
