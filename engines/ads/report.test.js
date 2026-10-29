import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import { buildReport, isMonitored, joinByDateAndAd } from './report.js';

const ins = (date, adId, adName, campaignId, campaignName, gasto, mensajes) => ({ date, adId, adName, campaignId, campaignName, adsetId: 's1', gasto, mensajes });
const sale = (date, adId, valor, extra = {}) => ({
  registered: `${date} 10:00`, date, result: 'Pago válido', phone: '573001234567', valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId, adLossy: false, adUrl: '', ...extra,
});

const insights = [
  ins('2026-10-28', 'A', 'Video 1', 'c1', 'CT01 - ventas', 20000, 40),
  ins('2026-10-28', 'B', 'Video 2', 'c1', 'CT01 - ventas', 10000, 10),
  ins('2026-10-28', 'C', 'Video 3', 'c2', 'CT02 - ventas', 30000, 30),
  ins('2026-10-28', 'X', 'Otro', 'c9', 'Branding', 99999, 5),
  ins('2026-10-29', 'A', 'Video 1', 'c1', 'CT01 - ventas', 5000, 5),
];
const comprobantes = [
  sale('2026-10-28', 'A', 60000),
  sale('2026-10-28', 'A', 15000),
  sale('2026-10-28', 'C', 30000),
  sale('2026-10-28', '', 14000),
  sale('2026-10-28', 'X', 9999),
  sale('2026-10-28', 'A', 15000, { result: 'Comprobante inválido' }),
  sale('2026-10-28', 'A', 77777, { flow: 'Barf Whats' }),
  sale('2026-10-29', 'A', 20000),
  sale('2026-10-27', 'A', 11111),
];
const identities = {
  A: { adName: 'Video 1', campaignId: 'c1', campaignName: 'CT01 - ventas' },
  B: { adName: 'Video 2', campaignId: 'c1', campaignName: 'CT01 - ventas' },
  C: { adName: 'Video 3', campaignId: 'c2', campaignName: 'CT02 - ventas' },
  X: { adName: 'Otro', campaignId: 'c9', campaignName: 'Branding' },
};
const ads = {
  A: { createdTime: '2026-10-25T10:00:00-0500', effectiveStatus: 'ACTIVE' },
  B: { createdTime: '2026-10-27T10:00:00-0500', effectiveStatus: 'ACTIVE' },
  C: { createdTime: '2026-10-20T10:00:00-0500', effectiveStatus: 'PAUSED' },
};
const run = (group = 'ct', overrides = {}) =>
  buildReport({ insights, comprobantes, identities, ads, config: DEFAULT_CONFIG, from: '2026-10-28', to: '2026-10-29', group, today: '2026-10-29', ...overrides });

test('isMonitored matches the prefix case-insensitively and "all" monitors everything', () => {
  assert.equal(isMonitored('CT01 - ventas', 'CT'), true);
  assert.equal(isMonitored('ct02', 'CT'), true);
  assert.equal(isMonitored('Branding', 'CT'), false);
  assert.equal(isMonitored('Branding', 'all'), true);
  assert.equal(isMonitored('Branding', ''), true);
});

test('joinByDateAndAd keys entries by date|adId and merges spend and sales', () => {
  const joined = joinByDateAndAd({ insights, sales: comprobantes.filter((c) => c.result === 'Pago válido' && c.flow.startsWith('Bebidas')) });
  const a = joined.get('2026-10-28|A');
  assert.equal(a.gasto, 20000);
  assert.equal(a.valor, 75000);
  assert.equal(a.ventas, 2);
  assert.equal(joined.get('2026-10-28|').valor, 14000);
  assert.equal(joined.get('2026-10-28|B').ventas, 0);
});

test('KPIs add up spend of CT campaigns and every valid payment of the flow', () => {
  const { kpis } = run();
  assert.equal(kpis.gasto, 65000);
  assert.equal(kpis.ventas, 5);
  assert.equal(kpis.valor, 139000);
  assert.equal(kpis.mensajes, 85);
  assert.equal(kpis.resultado, 74000);
  assert.ok(Math.abs(kpis.roas - 139000 / 65000) < 1e-9);
  assert.equal(kpis.costoVenta, 13000);
});

test('group by CT merges campaigns of the same code and keeps unattributed payments apart', () => {
  const { rows } = run('ct');
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['CT 01', 'CT 02', 'Sin anuncio']);
  assert.equal(byLabel['CT 01'].gasto, 35000);
  assert.equal(byLabel['CT 01'].mensajes, 55);
  assert.equal(byLabel['CT 01'].ventas, 3);
  assert.equal(byLabel['CT 01'].valor, 95000);
  assert.equal(byLabel['CT 01'].action.label, 'Escalar');
  assert.equal(byLabel['CT 02'].action.label, 'Vigilar');
  assert.equal(byLabel['Sin anuncio'].action, null);
  assert.equal(byLabel['Sin anuncio'].valor, 14000);
});

test('rows know the age of their oldest ad', () => {
  const { rows } = run('ct');
  assert.equal(rows.find((r) => r.label === 'CT 01').ageDays, 4);
  const adRows = run('ad').rows;
  assert.equal(adRows.find((r) => r.adId === 'B').ageDays, 2);
  assert.equal(adRows.find((r) => r.adId === 'A').effectiveStatus, 'ACTIVE');
});

test('group by campaign and by ad', () => {
  const camps = run('campaign').rows;
  assert.equal(camps.find((r) => r.campaignId === 'c1').gasto, 35000);
  const adRows = run('ad').rows;
  const a = adRows.find((r) => r.adId === 'A');
  assert.equal(a.gasto, 25000);
  assert.equal(a.ventas, 3);
  assert.equal(a.label, 'Video 1');
  assert.equal(a.ct, 'CT 01');
  assert.equal(adRows.find((r) => r.adId === 'B').action.label, 'Esperar');
});

test('ads outside the prefix are excluded, and "all" brings them back', () => {
  assert.equal(run('ad').rows.some((r) => r.adId === 'X'), false);
  const all = run('ad', { config: { ...DEFAULT_CONFIG, campaignPrefix: 'all' } });
  assert.equal(all.rows.some((r) => r.adId === 'X'), true);
  assert.equal(all.kpis.gasto, 164999);
});

test('daily series fills every day of the range', () => {
  const { daily } = run();
  assert.deepEqual(daily.map((d) => d.date), ['2026-10-28', '2026-10-29']);
  assert.equal(daily[0].gasto, 60000);
  assert.equal(daily[0].valor, 119000);
  assert.equal(daily[1].valor, 20000);
  assert.equal(daily[1].roas, 4);
  const wide = run('ct', { from: '2026-10-27', to: '2026-10-29' }).daily;
  assert.equal(wide.length, 3);
  assert.equal(wide[0].gasto, 0);
});

test('comprobantes list masks phones, flags review rows and resolves the CT', () => {
  const { comprobantes: list, reviewCount } = run();
  assert.equal(list.length, 6);
  assert.equal(reviewCount, 1);
  assert.ok(list.every((c) => c.phoneMasked === '••••4567'));
  assert.ok(list.every((c) => !('phone' in c)));
  const review = list.find((c) => c.status !== 'valid');
  assert.equal(review.status, 'invalid');
  assert.equal(review.ct, 'CT 01');
  assert.equal(list.find((c) => c.adId === '').ct, 'Sin anuncio');
  assert.equal(list.some((c) => c.valor === 77777 || c.valor === 9999 || c.valor === 11111), false);
});

test('a result that is neither valid nor invalid is "review"', () => {
  const out = run('ct', { comprobantes: [sale('2026-10-28', 'A', 1000, { result: 'Nombre a revisar' })] });
  assert.equal(out.comprobantes[0].status, 'review');
  assert.equal(out.kpis.ventas, 0);
});

test('payments of an ad with no identity are kept under an unknown ad', () => {
  const out = run('ad', { comprobantes: [sale('2026-10-28', '999', 5000)] });
  const row = out.rows.find((r) => r.adId === '999');
  assert.equal(row.valor, 5000);
  assert.equal(row.action, null);
  assert.match(row.label, /999/);
});

test('empty inputs produce zeros, never NaN', () => {
  const out = run('ct', { insights: [], comprobantes: [] });
  assert.equal(out.kpis.roas, 0);
  assert.deepEqual(out.rows, []);
  assert.equal(out.daily.length, 2);
});
