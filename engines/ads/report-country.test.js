import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { buildReport } from './report.js';

const ins = (adId, campaignName, country, gasto) => ({ date: '2026-10-28', adId, adName: `Ad ${adId}`, campaignId: `c${adId}`, campaignName, adsetId: 's', adsetName: 'S', gasto, mensajes: 10, country });
const pay = (adId, phone, valor, extra = {}) => ({ key: `${adId}-${phone}-${valor}`, registered: '28/10/2026 10:00:00', date: '2026-10-28', result: 'Pago válido', phone, valor, bank: 'X', flow: 'Bebidas - aporte', adId, adLossy: false, adUrl: '', country: '', countrySource: '', gone: false, ...extra });

const insights = [ins('A', 'CT01 Col', 'CO', 30000), ins('A', 'CT01 Col', 'MX', 10000), ins('B', 'CT02 MX', 'MX', 20000)];
const comprobantes = [pay('A', '573001234567', 60000), pay('A', '525512345678', 500), pay('B', '', 300)];
const identities = { A: { adName: 'Ad A', campaignId: 'cA', campaignName: 'CT01 Col' }, B: { adName: 'Ad B', campaignId: 'cB', campaignName: 'CT02 MX' } };
const config = mergeConfig({ enabledCountries: ['CO', 'MX', 'VE', 'EC'], countries: { MX: { rateToCop: 200, feePct: 5, costPerSale: 1000, taxPct: 16 } } });
const run = (over = {}) => buildReport({ insights, comprobantes, identities, config, from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29', ...over });

test('unfiltered totals add every country and convert values to COP', () => {
  const { kpis } = run();
  assert.equal(kpis.gasto, 60000);
  assert.equal(kpis.ventas, 3);
  assert.equal(kpis.valor, 60000 + 500 * 200 + 300 * 200);
});

test('the country table shows spend, sales, value in COP, fees, costs, taxes and margin per country', () => {
  const { countries } = run();
  const co = countries.find((c) => c.country === 'CO');
  const mx = countries.find((c) => c.country === 'MX');
  assert.deepEqual([co.gasto, co.ventas, co.valor, co.margen], [30000, 1, 60000, 30000]);
  assert.deepEqual([mx.gasto, mx.ventas, mx.valor, mx.comisiones, mx.costos, mx.impuestos], [30000, 2, 160000, 8000, 2000, 25600]);
  assert.equal(mx.margen, 160000 - 30000 - 8000 - 2000 - 25600);
  assert.ok(Math.abs(mx.margenPct - 94400 / 160000) < 1e-9);
  assert.ok(Math.abs(mx.roas - 160000 / 30000) < 1e-9);
  assert.equal(mx.rateMissing, false);
  assert.equal(mx.name, 'México');
});

test('a country filter keeps only that country in KPIs, rows, daily series and vouchers', () => {
  const r = run({ country: 'MX' });
  assert.equal(r.kpis.gasto, 30000);
  assert.equal(r.kpis.ventas, 2);
  assert.equal(r.kpis.valor, 160000);
  assert.equal(r.kpis.margen, 94400);
  assert.equal(r.daily[0].valor, 160000);
  assert.ok(r.comprobantes.every((c) => c.country === 'MX'));
  assert.equal(r.comprobantes.length, 2);
  assert.equal(run({ country: 'all' }).kpis.ventas, 3);
});

test('splitCountry separates CT rows by country', () => {
  const labels = run({ splitCountry: true }).rows.map((r) => r.label).sort();
  assert.deepEqual(labels, ['CT 01 · CO', 'CT 01 · MX', 'CT 02 · MX']);
  assert.deepEqual(run().rows.map((r) => r.label).sort(), ['CT 01', 'CT 02']);
});

test('the sale country comes from the phone, then the campaign, and says how', () => {
  const byKey = Object.fromEntries(run().comprobantes.map((c) => [c.key, c]));
  assert.deepEqual([byKey['A-573001234567-60000'].country, byKey['A-573001234567-60000'].countrySource], ['CO', 'telefono']);
  assert.deepEqual([byKey['A-525512345678-500'].country, byKey['A-525512345678-500'].countrySource], ['MX', 'telefono']);
  assert.deepEqual([byKey['B--300'].country, byKey['B--300'].countrySource], ['MX', 'campana']);
});

test('a stored or manual country wins over the derivation', () => {
  const manual = [pay('A', '573001234567', 1000, { country: 'MX', countrySource: 'manual' })];
  const r = run({ comprobantes: manual });
  assert.equal(r.comprobantes[0].country, 'MX');
  assert.equal(r.comprobantes[0].countrySource, 'manual');
  assert.equal(r.kpis.valor, 1000 * 200);
});

test('a non-COP country without a rate is flagged and not converted', () => {
  const r = buildReport({ insights, comprobantes, identities, config: mergeConfig({ enabledCountries: ['CO', 'MX'] }), from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  assert.equal(r.countries.find((c) => c.country === 'MX').rateMissing, true);
  assert.equal(r.kpis.valor, 60000 + 500 + 300);
});

test('a country with no settings at all is flagged until a rate is set (only Colombia needs none)', () => {
  const ec = [pay('A', '593987654321', 20000)];
  const r = buildReport({ insights: [], comprobantes: ec, identities, config: mergeConfig({ enabledCountries: ['CO', 'EC'] }), from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  assert.equal(r.countries.find((c) => c.country === 'EC').rateMissing, true);
  assert.equal(r.countries.find((c) => c.country === 'EC').name, 'Ecuador');
  const co = buildReport({ insights: [], comprobantes: [pay('A', '573001234567', 1)], identities, config: DEFAULT_CONFIG, from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  assert.equal(co.countries.find((c) => c.country === 'CO').rateMissing, false);
});

test('rows that left the sheet are still counted and flagged', () => {
  const r = run({ comprobantes: [pay('A', '573001234567', 1000, { gone: true })] });
  assert.equal(r.kpis.ventas, 1);
  assert.equal(r.comprobantes[0].gone, true);
});

const only = (extra = {}) => mergeConfig(extra);

test('by default only Colombia is shown: other countries are left out of KPIs, tables, daily and vouchers', () => {
  const r = buildReport({ insights, comprobantes, identities, config: only({ countries: { MX: { rateToCop: 200 } } }), from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  assert.deepEqual(r.countries.map((c) => c.country), ['CO']);
  assert.equal(r.kpis.gasto, 30000, 'MX spend is left out');
  assert.equal(r.kpis.ventas, 1);
  assert.equal(r.kpis.valor, 60000);
  assert.equal(r.daily[0].valor, 60000);
  assert.ok(r.comprobantes.every((c) => c.country === 'CO'));
  assert.deepEqual(r.detected.map((d) => d.country).sort(), ['CO', 'MX'], 'the settings can still offer the countries that have data');
});

test('"incluir otros países" groups the non-enabled ones as "Otros países" instead of hiding them', () => {
  const r = buildReport({ insights, comprobantes, identities, config: only({ includeOtherCountries: true, countries: { MX: { rateToCop: 200 } } }), from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  assert.deepEqual(r.countries.map((c) => c.country).sort(), ['CO', 'XX']);
  assert.equal(r.countries.find((c) => c.country === 'XX').name, 'Otros países');
  assert.equal(r.kpis.gasto, 60000);
  assert.equal(r.kpis.ventas, 3);
  assert.equal(buildReport({ insights, comprobantes, identities, config: only({ includeOtherCountries: true }), from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29', country: 'XX' }).kpis.ventas, 2);
});

test('the filter "-" selects data without a country and empty countries never show as rows', () => {
  const noCountry = [ins('A', 'CT01 Col', '', 5000)];
  const r = buildReport({ insights: noCountry, comprobantes: [], identities, config, from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29', country: '-' });
  assert.equal(r.kpis.gasto, 5000);
  const none = buildReport({ insights: [ins('A', 'CT01 Col', '', 0)], comprobantes: [], identities, config, from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  assert.deepEqual(none.countries, [], 'a zero row is not a country');
});

test('the enabled countries setting is validated and keeps Colombia by default', () => {
  assert.deepEqual(DEFAULT_CONFIG.enabledCountries, ['CO']);
  assert.equal(DEFAULT_CONFIG.includeOtherCountries, false);
  assert.deepEqual(mergeConfig({ enabledCountries: ['co', 'mx', 'MX'] }).enabledCountries, ['CO', 'MX']);
  assert.throws(() => mergeConfig({ enabledCountries: [] }), /al menos un país/);
  assert.throws(() => mergeConfig({ enabledCountries: ['Mexico'] }), /al menos un país/);
});
