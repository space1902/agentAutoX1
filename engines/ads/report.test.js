import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import { buildReport, isMonitored, joinByDateAndAd } from './report.js';

// Legacy expectations are written without IVA; the IVA behavior has its own tests.
const NO_VAT = { ...DEFAULT_CONFIG, spendVatPct: 0, campaignPrefix: 'CT' };

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
  A: { createdTime: '2026-10-24T10:00:00-0500', firstSpendDate: '2026-10-26', effectiveStatus: 'ACTIVE' },
  B: { createdTime: '2026-10-27T10:00:00-0500', firstSpendDate: '2026-10-28', effectiveStatus: 'ACTIVE' },
  C: { createdTime: '2026-10-20T10:00:00-0500', effectiveStatus: 'PAUSED' },
};
const run = (group = 'campaign', overrides = {}) =>
  buildReport({ insights, comprobantes, identities, ads, config: NO_VAT, from: '2026-10-28', to: '2026-10-29', group, today: '2026-10-29', ...overrides });

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

test('KPIs add up spend of the monitored campaigns and every valid payment of the flow', () => {
  const { kpis } = run();
  assert.equal(kpis.gasto, 65000);
  assert.equal(kpis.ventas, 5);
  assert.equal(kpis.valor, 139000);
  assert.equal(kpis.mensajes, 85);
  assert.equal(kpis.resultado, 74000);
  assert.ok(Math.abs(kpis.roas - 139000 / 65000) < 1e-9);
  assert.equal(kpis.costoVenta, 13000);
});

test('group by campaign keeps unattributed payments apart', () => {
  const { rows } = run('campaign');
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['CT01 - ventas', 'CT02 - ventas', 'Sin anuncio']);
  assert.equal(byLabel['CT01 - ventas'].gasto, 35000);
  assert.equal(byLabel['CT01 - ventas'].mensajes, 55);
  assert.equal(byLabel['CT01 - ventas'].ventas, 3);
  assert.equal(byLabel['CT01 - ventas'].valor, 95000);
  assert.equal(byLabel['CT01 - ventas'].ct, 'CT 01');
  assert.equal(byLabel['CT01 - ventas'].action.label, 'Escalar');
  // Its only ad (C) is PAUSED in Meta: no recommendation, the metrics stay.
  assert.equal(byLabel['CT02 - ventas'].action.label, 'Apagada');
  assert.equal(byLabel['CT02 - ventas'].paused, true);
  assert.equal(byLabel['CT02 - ventas'].suggestedAction.label, 'Vigilar');
  assert.equal(byLabel['CT02 - ventas'].gasto, 30000);
  assert.equal(byLabel['Sin anuncio'].action, null);
  assert.equal(byLabel['Sin anuncio'].valor, 14000);
});

test('day N counts from the first day with spend, not from created_time, and is null before any spend', () => {
  const { rows } = run('campaign');
  assert.equal(rows.find((r) => r.label === 'CT01 - ventas').ageDays, 4);
  const adRows = run('ad').rows;
  assert.equal(adRows.find((r) => r.adId === 'B').ageDays, 2);
  assert.equal(adRows.find((r) => r.adId === 'A').effectiveStatus, 'ACTIVE');
  assert.equal(adRows.find((r) => r.adId === 'A').firstSpendDate, '2026-10-26');
  const noSpend = run('ad', { ads: { ...ads, B: { createdTime: ads.B.createdTime } } }).rows;
  assert.equal(noSpend.find((r) => r.adId === 'B').ageDays, null);
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
  const all = run('ad', { config: { ...NO_VAT, campaignPrefix: 'all' } });
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
  const wide = run('campaign', { from: '2026-10-27', to: '2026-10-29' }).daily;
  assert.equal(wide.length, 3);
  assert.equal(wide[0].gasto, 0);
});

test('comprobantes list carries phone and names, masks the short form, flags review rows and resolves the campaign', () => {
  const { comprobantes: list, reviewCount } = run();
  assert.equal(list.length, 6);
  assert.equal(reviewCount, 1);
  assert.ok(list.every((c) => c.phoneMasked === '••••4567'));
  assert.ok(list.every((c) => c.phone === '573001234567'));
  assert.ok(list.every((c) => c.clientName === '' && c.payerName === ''));
  const review = list.find((c) => c.status !== 'valid');
  assert.equal(review.status, 'invalid');
  assert.equal(review.campaign, 'CT01 - ventas');
  assert.equal(list.find((c) => c.adId === '').campaign, 'Sin anuncio');
  assert.equal(list.some((c) => c.valor === 77777 || c.valor === 9999 || c.valor === 11111), false);
});

test('a result that is neither valid nor invalid is "review"', () => {
  const out = run('campaign', { comprobantes: [sale('2026-10-28', 'A', 1000, { result: 'Nombre a revisar' })] });
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
  const out = run('campaign', { insights: [], comprobantes: [] });
  assert.equal(out.kpis.roas, 0);
  assert.deepEqual(out.rows, []);
  assert.equal(out.daily.length, 2);
});

// ---------------------------------------------------------------- delivery state ("Apagada")

test('a campaign whose ads are all off in Meta shows Apagada; with one active ad the recommendation stays', () => {
  const rows = (status) => run('campaign', { ads: { ...ads, A: { ...ads.A, effectiveStatus: status.A }, B: { ...ads.B, effectiveStatus: status.B } } }).rows;
  const ct1 = (status) => rows(status).find((r) => r.label === 'CT01 - ventas');
  assert.equal(ct1({ A: 'PAUSED', B: 'CAMPAIGN_PAUSED' }).action.label, 'Apagada');
  assert.equal(ct1({ A: 'ARCHIVED', B: 'ADSET_PAUSED' }).paused, true);
  assert.equal(ct1({ A: 'PAUSED', B: 'ACTIVE' }).paused, false);
  assert.equal(ct1({ A: 'PAUSED', B: 'ACTIVE' }).action.label, 'Escalar');
  // Problems are not a deliberate stop.
  assert.equal(ct1({ A: 'PAUSED', B: 'DISAPPROVED' }).paused, false);
  assert.equal(ct1({ A: 'PAUSED', B: 'PAUSED' }).gasto, 35000, 'metrics are kept');
});

test('a campaign with an active ad that has no spend in the range is not paused (status of every known ad counts)', () => {
  const extra = { ...ads, A: { ...ads.A, effectiveStatus: 'PAUSED' }, B: { ...ads.B, effectiveStatus: 'PAUSED' }, N: { name: 'Nuevo', campaignId: 'c1', campaignName: 'CT01 - ventas', effectiveStatus: 'ACTIVE' } };
  assert.equal(run('campaign', { ads: extra }).rows.find((r) => r.label === 'CT01 - ventas').paused, false);
});

test('a spending ad with unknown status keeps the recommendation', () => {
  const partial = { A: { ...ads.A, effectiveStatus: 'PAUSED' }, B: { ...ads.B, effectiveStatus: '' } };
  assert.equal(run('campaign', { ads: partial }).rows.find((r) => r.label === 'CT01 - ventas').paused, false);
});

test('campaign and ad tables show Apagada per entity', () => {
  const off = { ...ads, A: { ...ads.A, effectiveStatus: 'CAMPAIGN_PAUSED' }, B: { ...ads.B, effectiveStatus: 'ACTIVE' } };
  const byCampaign = run('campaign', { ads: off }).rows;
  assert.equal(byCampaign.find((r) => r.campaignId === 'c2').paused, true, 'C is PAUSED');
  assert.equal(byCampaign.find((r) => r.campaignId === 'c1').paused, false, 'B is still active');
  const byAd = run('ad', { ads: off }).rows;
  assert.equal(byAd.find((r) => r.adId === 'A').action.label, 'Apagada');
  assert.equal(byAd.find((r) => r.adId === 'B').paused, false);
});

test('Apagada also applies when the campaign is split by country', () => {
  const off = { ...ads, A: { ...ads.A, effectiveStatus: 'PAUSED' }, B: { ...ads.B, effectiveStatus: 'PAUSED' } };
  const rows = run('campaign', { ads: off, splitCountry: true }).rows.filter((r) => r.label.startsWith('CT01 - ventas'));
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.paused));
});

test('IVA on the spend: gasto includes it everywhere, spendNet keeps the raw value and ROAS uses the net spend; margin/costs use the gross spend', () => {
  const r = run('campaign', { config: { ...NO_VAT, spendVatPct: 19, campaignPrefix: 'CT' } });
  const k = r.kpis;
  assert.equal(k.spendNet, 65000); // 20000 + 10000 + 30000 + 5000
  assert.equal(k.gasto, 65000 * 1.19);
  assert.equal(k.vat, 65000 * 0.19);
  assert.equal(k.gasto, k.spendNet + k.vat);
  assert.equal(k.roas, k.valor / 65000); // ROAS = value / spend WITHOUT IVA
  assert.equal(k.resultado, k.valor - 65000 * 1.19);
  assert.equal(k.costoMensaje, (65000 * 1.19) / 85);
  assert.equal(k.costoVenta, (65000 * 1.19) / k.ventas);
  assert.equal(r.spendVatPct, 19);
  const ct1 = r.rows.find((x) => x.campaignId === 'c1');
  assert.equal(ct1.gasto, 35000 * 1.19);
  assert.equal(ct1.vat, 35000 * 0.19);
  assert.equal(r.rows.reduce((n, x) => n + x.gasto, 0), k.gasto);
  const d28 = r.daily.find((x) => x.date === '2026-10-28');
  assert.equal(d28.gasto, 60000 * 1.19);
  assert.equal(d28.spendNet, 60000);
  assert.equal(d28.roas, d28.valor / 60000);
  const chart = r.campaignDaily.find((c) => c.campaignId === 'c1').daily.find((x) => x.date === '2026-10-29');
  assert.equal(chart.gasto, 5000 * 1.19);
  assert.equal(chart.vat, 5000 * 0.19);
});

test('with 0 % IVA the spend is untouched', () => {
  const k = run('campaign').kpis;
  assert.equal(k.gasto, k.spendNet);
  assert.equal(k.vat, 0);
});

test('ROAS divides by the spend WITHOUT IVA; cost per sale, margin and result keep the spend WITH IVA', () => {
  const config = { ...DEFAULT_CONFIG, spendVatPct: 19, campaignPrefix: 'CT' };
  const r = buildReport({
    insights: [ins('2026-10-28', 'A', 'Video 1', 'c1', 'CT01 - ventas', 139074 / 1.19, 40)],
    comprobantes: [sale('2026-10-28', 'A', 447000)],
    identities, ads, config, from: '2026-10-28', to: '2026-10-28', group: 'ad', today: '2026-10-29',
  });
  const net = 139074 / 1.19;
  assert.ok(Math.abs(r.kpis.gasto - 139074) < 1e-6);
  assert.ok(Math.abs(r.kpis.roas - 447000 / net) < 1e-9);
  assert.ok(Math.abs(r.rows[0].roas - 447000 / net) < 1e-9);
  assert.ok(Math.abs(r.daily[0].roas - 447000 / net) < 1e-9);
  assert.ok(Math.abs(r.kpis.costoVenta - 139074) < 1e-6);
  assert.ok(Math.abs(r.kpis.resultado - (447000 - 139074)) < 1e-6);
  assert.ok(Math.abs(r.campaignDaily[0].daily[0].roas - 447000 / net) < 1e-9);
});

test('ROAS is unchanged when the IVA is 0', () => {
  const r = run('campaign');
  assert.equal(r.kpis.roas, r.kpis.valor / r.kpis.gasto);
});
