import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig } from './config.js';
import { buildReport } from './report.js';
import { ScopeError, convertAmount, matchesName, parseNamePrefixes } from './scope.js';

const config = mergeConfig({ spendVatPct: 0, currency: 'COP', enabledCountries: ['CO'] });
const ins = (adId, adName, accountId, gasto) => ({ date: '2026-10-28', adId, adName, campaignId: `c${adId}`, campaignName: `Camp ${adId}`, adsetId: 's', adsetName: 'S', gasto, mensajes: 1, country: 'CO', accountId });
const pay = (adId, n, valor) => ({ key: `k${adId}${n}`, registered: `28/10/2026 10:0${n}:00`, date: '2026-10-28', result: 'Pago válido', phone: `57300000000${n}`, valor, bank: 'X', flow: 'Bebidas - aporte', adId, adLossy: false, adUrl: '', country: 'CO', countrySource: 'telefono', gone: false });

const insights = [ins('A', 'CT01 video', 'act_11111', 10000), ins('B', 'PZZ promo', 'act_22222', 20000), ins('C', 'ct02 otro', 'act_22222', 5000)];
const identities = Object.fromEntries(insights.map((r) => [r.adId, { adName: r.adName, campaignId: r.campaignId, campaignName: r.campaignName, accountId: r.accountId }]));
const comprobantes = [pay('A', 1, 50000), pay('B', 2, 40000), pay('C', 3, 9000), pay('', 4, 7000), pay('ZZZ', 5, 3000)];
const accountMeta = { act_11111: { name: 'Uno', currency: 'COP', portfolioName: 'P1' }, act_22222: { name: 'Dos', currency: 'COP', portfolioName: 'P2' } };
const run = (over = {}) => buildReport({ insights, comprobantes, identities, config, from: '2026-10-28', to: '2026-10-28', group: 'ad', today: '2026-10-29', accountMeta, ...over });

test('no account or name filter keeps the old totals, including unattributed sales, and labels them "Sin cuenta"', () => {
  const r = run();
  assert.equal(r.kpis.gasto, 35000);
  assert.equal(r.kpis.valor, 109000);
  const byId = Object.fromEntries(r.accounts.map((a) => [a.accountId, a]));
  assert.equal(byId.act_11111.gasto, 10000);
  assert.equal(byId.act_11111.valor, 50000);
  assert.equal(byId.act_22222.gasto, 25000);
  assert.equal(byId[''].name, 'Sin cuenta');
  assert.equal(byId[''].valor, 7000 + 3000);
  assert.deepEqual(r.notes, []);
});

test('an account filter keeps that account\'s spend and only the sales that map to its ads', () => {
  const r = run({ accounts: { all: false, ids: ['act_22222'] } });
  assert.equal(r.kpis.gasto, 25000);
  assert.equal(r.kpis.valor, 49000);
  assert.equal(r.accounts.length, 1);
  assert.ok(r.comprobantes.every((c) => ['B', 'C'].includes(c.adId)));
  assert.ok(r.notes.some((n) => n.code === 'unattributed_sales' && n.count === 2));
});

test('selecting every account behaves as "all"', () => {
  const r = run({ accounts: { all: true, ids: ['act_11111', 'act_22222'] } });
  assert.equal(r.kpis.valor, 109000);
});

test('the name filter is starts-with, case-insensitive, comma separated, and only counts sales of matching ads', () => {
  const r = run({ names: parseNamePrefixes(' ct , ,PZZ ') });
  assert.equal(r.kpis.gasto, 35000);
  assert.equal(r.kpis.valor, 50000 + 40000 + 9000);
  const ct = run({ names: parseNamePrefixes('ct') });
  assert.equal(ct.kpis.gasto, 15000);
  assert.equal(ct.kpis.valor, 59000);
  assert.ok(ct.notes.some((n) => n.code === 'unattributed_sales'));
  assert.equal(run({ names: parseNamePrefixes('video') }).kpis.gasto, 0, 'contains is not starts-with');
  assert.deepEqual(r.nameFilter, ['ct', 'pzz']);
});

test('account and name filters combine with the country filter', () => {
  const r = run({ accounts: { all: false, ids: ['act_22222'] }, names: ['ct'], country: 'CO' });
  assert.equal(r.kpis.gasto, 5000);
  assert.equal(r.kpis.valor, 9000);
});

test('spend in another currency is converted to the base currency', () => {
  const usd = { act_11111: { name: 'Uno', currency: 'USD' }, act_22222: accountMeta.act_22222 };
  const r = run({ accountMeta: usd, fxRates: { USD: [{ date: '2026-10-28', rate: 4000 }] } });
  assert.equal(r.kpis.gasto, 10000 * 4000 + 25000);
  assert.equal(r.warnings.length, 0);
});

test('a missing rate is reported and that spend is not silently mixed in', () => {
  const usd = { act_11111: { name: 'Uno', currency: 'USD' }, act_22222: accountMeta.act_22222 };
  const r = run({ accountMeta: usd, fxRates: {} });
  assert.equal(r.kpis.gasto, 25000);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /USD/);
  assert.match(r.warnings[0].message, /Uno/);
});

test('parseNamePrefixes validates length and charset', () => {
  assert.deepEqual(parseNamePrefixes(undefined), []);
  assert.deepEqual(parseNamePrefixes('CT01 - ventas'), ['ct01 - ventas']);
  assert.throws(() => parseNamePrefixes("x'; DROP TABLE ads;--"), ScopeError);
  assert.throws(() => parseNamePrefixes('<script>'), ScopeError);
  assert.throws(() => parseNamePrefixes('a'.repeat(61)), ScopeError);
  assert.throws(() => parseNamePrefixes(Array.from({ length: 25 }, (_, i) => `p${i}`).join(',')), ScopeError);
  assert.equal(matchesName('CT01 video', ['ct']), true);
  assert.equal(matchesName('xCT01', ['ct']), false);
  assert.equal(matchesName('anything', []), true);
});

test('convertAmount handles same currency, rates through COP and missing rates', () => {
  assert.equal(convertAmount(10, 'COP', 'COP', '2026-10-28', config, {}), 10);
  assert.equal(convertAmount(10, 'USD', 'COP', '2026-10-28', config, { USD: [{ date: '2026-10-01', rate: 4000 }] }), 40000);
  assert.equal(convertAmount(40000, 'COP', 'USD', '2026-10-28', config, { USD: [{ date: '2026-10-01', rate: 4000 }] }), 10);
  assert.equal(convertAmount(10, 'EUR', 'COP', '2026-10-28', config, {}), null);
});

test('under "Todas" a removed account’s history does not count (nothing is deleted), but legacy rows without an account do', () => {
  const old = ins('Z', 'ct old', 'act_99999', 7000);
  const legacy = ins('Y', 'ct legacy', '', 3000);
  const all = [...insights, old, legacy];
  const ids = { ...identities, Z: { adName: 'ct old', campaignId: 'cZ', campaignName: 'Camp Z', accountId: 'act_99999' }, Y: { adName: 'ct legacy', campaignId: 'cY', campaignName: 'Camp Y', accountId: '' } };
  const sales = [...comprobantes, pay('Z', 6, 4000)];
  const r = run({ insights: all, identities: ids, comprobantes: sales, accounts: { all: true, ids: ['act_11111', 'act_22222'] } });
  assert.equal(r.kpis.gasto, 35000 + 3000);
  assert.equal(r.kpis.valor, 109000, 'the removed account’s payment is not counted either');
  assert.equal(run({ insights: all, identities: ids, comprobantes: sales }).kpis.gasto, 35000 + 7000 + 3000, 'without a selection nothing changes');
});
