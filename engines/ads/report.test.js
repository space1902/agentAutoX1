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
  A: { createdTime: '2026-10-24T10:00:00-0500', firstSpendDate: '2026-10-26', effectiveStatus: 'ACTIVE' },
  B: { createdTime: '2026-10-27T10:00:00-0500', firstSpendDate: '2026-10-28', effectiveStatus: 'ACTIVE' },
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
  // Its only ad (C) is PAUSED in Meta: no recommendation, the metrics stay.
  assert.equal(byLabel['CT 02'].action.label, 'Apagada');
  assert.equal(byLabel['CT 02'].paused, true);
  assert.equal(byLabel['CT 02'].suggestedAction.label, 'Vigilar');
  assert.equal(byLabel['CT 02'].gasto, 30000);
  assert.equal(byLabel['Sin anuncio'].action, null);
  assert.equal(byLabel['Sin anuncio'].valor, 14000);
});

test('day N counts from the first day with spend, not from created_time, and is null before any spend', () => {
  const { rows } = run('ct');
  assert.equal(rows.find((r) => r.label === 'CT 01').ageDays, 4);
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

test('comprobantes list carries phone and names, masks the short form, flags review rows and resolves the CT', () => {
  const { comprobantes: list, reviewCount } = run();
  assert.equal(list.length, 6);
  assert.equal(reviewCount, 1);
  assert.ok(list.every((c) => c.phoneMasked === '••••4567'));
  assert.ok(list.every((c) => c.phone === '573001234567'));
  assert.ok(list.every((c) => c.clientName === '' && c.payerName === ''));
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

test('CT 10 is never counted inside CT 01 and names without a CT go to "Sin CT" with an issue list', () => {
  const rows = [
    ins('2026-10-28', 'P', 'Pa', 'c-1', 'CT01 Col 2', 10000, 5),
    ins('2026-10-28', 'Q', 'Qa', 'c-10', 'CT 10 Col 2 - ventas', 20000, 5),
    ins('2026-10-28', 'R', 'Ra', 'c-100', 'CT100', 30000, 5),
    ins('2026-10-28', 'S', 'Sa', 'c-x', 'CTX prueba', 40000, 5),
    ins('2026-10-28', 'T', 'Ta', 'c-amb', 'CT 1 0', 50000, 5),
  ];
  const ids = Object.fromEntries(rows.map((r) => [r.adId, { adName: r.adName, campaignId: r.campaignId, campaignName: r.campaignName }]));
  const out = buildReport({ insights: rows, comprobantes: [], identities: ids, config: DEFAULT_CONFIG, from: '2026-10-28', to: '2026-10-28', group: 'ct', today: '2026-10-29' });
  const byLabel = Object.fromEntries(out.rows.map((r) => [r.label, r.gasto]));
  assert.equal(byLabel['CT 10'], 20000);
  assert.equal(byLabel['CT 100'], 30000);
  assert.equal(byLabel['CT 01'], 60000, 'CT01 plus the ambiguous "CT 1 0", which reads as CT 1');
  assert.equal(byLabel['Sin CT'], 40000);
  assert.equal(out.rows.find((r) => r.label === 'Sin CT').ctIssue, true);
  assert.deepEqual(out.ctIssues.map((i) => [i.campaignName, i.reason]).sort(), [['CT 1 0', 'ambiguo'], ['CTX prueba', 'sin_ct']]);
});

test('empty inputs produce zeros, never NaN', () => {
  const out = run('ct', { insights: [], comprobantes: [] });
  assert.equal(out.kpis.roas, 0);
  assert.deepEqual(out.rows, []);
  assert.equal(out.daily.length, 2);
});

test('ctDaily holds one daily series per CT with spend, value and ROAS, whatever the table grouping', () => {
  for (const group of ['ct', 'campaign', 'ad']) {
    const out = run(group);
    assert.deepEqual(out.ctDaily.map((c) => c.ct), ['CT 01', 'CT 02', 'Sin anuncio']);
    const ct1 = out.ctDaily.find((c) => c.ct === 'CT 01');
    assert.deepEqual(ct1.daily.map((d) => d.date), ['2026-10-28', '2026-10-29']);
    assert.equal(ct1.daily[0].gasto, 30000);
    assert.equal(ct1.daily[0].valor, 75000);
    assert.equal(ct1.daily[0].roas, 2.5);
    assert.equal(ct1.daily[1].gasto, 5000);
    assert.equal(ct1.daily[1].valor, 20000);
    assert.equal(ct1.daily[1].roas, 4);
    const ct2 = out.ctDaily.find((c) => c.ct === 'CT 02');
    assert.equal(ct2.daily[1].gasto, 0);
    assert.equal(ct2.daily[1].roas, 0);
  }
});

test('ctDaily series add up to the total daily series and empty CTs are left out', () => {
  const out = run('ct');
  for (let i = 0; i < out.daily.length; i += 1) {
    assert.equal(out.ctDaily.reduce((n, c) => n + c.daily[i].gasto, 0), out.daily[i].gasto);
    assert.equal(out.ctDaily.reduce((n, c) => n + c.daily[i].valor, 0), out.daily[i].valor);
  }
  assert.deepEqual(run('ct', { insights: [], comprobantes: [] }).ctDaily, []);
});

// ---------------------------------------------------------------- delivery state ("Apagada")

test('a CT whose ads are all off in Meta shows Apagada; with one active ad the recommendation stays', () => {
  const rows = (status) => run('ct', { ads: { ...ads, A: { ...ads.A, effectiveStatus: status.A }, B: { ...ads.B, effectiveStatus: status.B } } }).rows;
  const ct1 = (status) => rows(status).find((r) => r.label === 'CT 01');
  assert.equal(ct1({ A: 'PAUSED', B: 'CAMPAIGN_PAUSED' }).action.label, 'Apagada');
  assert.equal(ct1({ A: 'ARCHIVED', B: 'ADSET_PAUSED' }).paused, true);
  assert.equal(ct1({ A: 'PAUSED', B: 'ACTIVE' }).paused, false);
  assert.equal(ct1({ A: 'PAUSED', B: 'ACTIVE' }).action.label, 'Escalar');
  // Problems are not a deliberate stop.
  assert.equal(ct1({ A: 'PAUSED', B: 'DISAPPROVED' }).paused, false);
  assert.equal(ct1({ A: 'PAUSED', B: 'PAUSED' }).gasto, 35000, 'metrics are kept');
});

test('a CT with an active ad that has no spend in the range is not paused (status of every known ad counts)', () => {
  const extra = { ...ads, A: { ...ads.A, effectiveStatus: 'PAUSED' }, B: { ...ads.B, effectiveStatus: 'PAUSED' }, N: { name: 'Nuevo', campaignId: 'c1', campaignName: 'CT01 - ventas', effectiveStatus: 'ACTIVE' } };
  assert.equal(run('ct', { ads: extra }).rows.find((r) => r.label === 'CT 01').paused, false);
});

test('a spending ad with unknown status keeps the recommendation', () => {
  const partial = { A: { ...ads.A, effectiveStatus: 'PAUSED' }, B: { ...ads.B, effectiveStatus: '' } };
  assert.equal(run('ct', { ads: partial }).rows.find((r) => r.label === 'CT 01').paused, false);
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

test('Apagada also applies when the CT is split by country', () => {
  const off = { ...ads, A: { ...ads.A, effectiveStatus: 'PAUSED' }, B: { ...ads.B, effectiveStatus: 'PAUSED' } };
  const rows = run('ct', { ads: off, splitCountry: true }).rows.filter((r) => r.label.startsWith('CT 01'));
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.paused));
});
