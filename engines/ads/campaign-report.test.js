import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import { buildReport } from './report.js';

// One row per real Meta campaign: the CT code in a name never merges campaigns.
const CFG = { ...DEFAULT_CONFIG, spendVatPct: 19 };

const ins = (date, adId, adName, campaignId, campaignName, gasto, mensajes = 0) => ({ date, adId, adName, campaignId, campaignName, adsetId: `s-${campaignId}`, gasto, mensajes });
const sale = (date, adId, valor, extra = {}) => ({
  registered: `${date} 10:00`, date, result: 'Pago válido', phone: '573001234567', valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId, adLossy: false, adUrl: '', ...extra,
});

const insights = [
  ins('2026-10-28', 'A1', 'Video 1', 'c1', 'CT 01 Col 2 - ventas', 17106 / 1.19, 10),
  ins('2026-10-28', 'A2', 'Video 1 b', 'c2', 'CT 01 Col 2', 13011 / 1.19, 30),
  ins('2026-10-28', 'A3', 'Banner', 'c3', 'Branding octubre', 10000, 2),
  ins('2026-10-28', 'A4', 'Viejo', 'c4', 'Remarketing', 5000, 1),
];
const identities = Object.fromEntries(insights.map((r) => [r.adId, { adName: r.adName, campaignId: r.campaignId, campaignName: r.campaignName }]));
const ads = {
  A1: { effectiveStatus: 'ACTIVE', campaignId: 'c1', campaignName: 'CT 01 Col 2 - ventas' },
  A2: { effectiveStatus: 'ACTIVE', campaignId: 'c2', campaignName: 'CT 01 Col 2' },
  A3: { effectiveStatus: 'ACTIVE', campaignId: 'c3', campaignName: 'Branding octubre' },
  A4: { effectiveStatus: 'PAUSED', campaignId: 'c4', campaignName: 'Remarketing' },
  // Never had spend in the synced range, but Meta still lists it under c1.
  A5: { effectiveStatus: 'ACTIVE', campaignId: 'c1', campaignName: 'CT 01 Col 2 - ventas', name: 'Nuevo' },
};
const comprobantes = [
  sale('2026-10-28', 'A1', 60000),
  sale('2026-10-28', 'A2', 30000),
  sale('2026-10-28', 'A5', 10000),
  sale('2026-10-28', 'A3', 5000),
  sale('2026-10-28', '', 7000),
];
const run = (over = {}) => buildReport({ insights, comprobantes, identities, ads, config: CFG, from: '2026-10-28', to: '2026-10-28', group: 'campaign', today: '2026-10-29', ...over });

test('campaigns that share a CT code stay as two rows labeled with their full names', () => {
  const { rows } = run();
  const a = rows.find((r) => r.campaignId === 'c1');
  const b = rows.find((r) => r.campaignId === 'c2');
  assert.equal(a.label, 'CT 01 Col 2 - ventas');
  assert.equal(b.label, 'CT 01 Col 2');
  assert.ok(Math.abs(a.gasto - 17106) < 1e-6);
  assert.ok(Math.abs(b.gasto - 13011) < 1e-6);
  assert.equal(rows.filter((r) => r.label.startsWith('CT 01')).length, 2);
});

test('the legacy "ct" grouping is the campaign grouping (it never merges by code)', () => {
  const legacy = run({ group: 'ct' });
  assert.equal(legacy.group, 'campaign');
  assert.deepEqual(legacy.rows.map((r) => r.key).sort(), run().rows.map((r) => r.key).sort());
});

test('campaigns without CT in the name are rows like any other', () => {
  const { rows } = run({ config: { ...CFG, campaignPrefix: 'all' } });
  const brand = rows.find((r) => r.campaignId === 'c3');
  assert.equal(brand.label, 'Branding octubre');
  assert.equal(brand.ventas, 1);
  assert.equal(brand.valor, 5000);
});

test('payments follow their ad id to the campaign that owns it, even without insights for that ad', () => {
  const { rows } = run();
  assert.equal(rows.find((r) => r.campaignId === 'c1').ventas, 2, 'A1 and A5 both belong to c1');
  assert.equal(rows.find((r) => r.campaignId === 'c1').valor, 70000);
  assert.equal(rows.find((r) => r.campaignId === 'c2').valor, 30000);
});

test('payments without an ad id stay under "Sin anuncio" and are never guessed from a CT code', () => {
  const { rows } = run();
  const none = rows.find((r) => r.label === 'Sin anuncio');
  assert.equal(none.valor, 7000);
  assert.equal(rows.filter((r) => r.campaignId).reduce((n, r) => n + r.valor, 0) + none.valor, run().kpis.valor);
});

test('inactive campaigns are flagged and summed, and totals still include them', () => {
  const r = run();
  const paused = r.rows.find((x) => x.campaignId === 'c4');
  assert.equal(paused.paused, true);
  assert.equal(r.inactive.count, 1);
  assert.ok(Math.abs(r.inactive.gasto - 5000 * 1.19) < 1e-6);
  const all = r.rows.reduce((n, x) => n + x.gasto, 0);
  assert.ok(Math.abs(r.kpis.gasto - all) < 1e-6, 'KPIs hold the spend of the paused campaign too');
});

test('campaignDaily lists one series per campaign with its name and state, in the same order as the table', () => {
  const r = run();
  const c4 = r.campaignDaily.find((c) => c.campaignId === 'c4');
  assert.equal(c4.campaign, 'Remarketing');
  assert.equal(c4.paused, true);
  const c1 = r.campaignDaily.find((c) => c.campaignId === 'c1');
  assert.equal(c1.paused, false);
  assert.equal(c1.daily[0].valor, 70000);
  assert.equal(r.ctDaily, undefined);
  for (const g of ['campaign', 'ad']) {
    const out = run({ group: g });
    assert.equal(out.campaignDaily.reduce((n, c) => n + c.daily[0].gasto, 0), out.daily[0].gasto);
  }
});

test('the voucher list names the campaign of each payment', () => {
  const { comprobantes: list } = run();
  const byAd = Object.fromEntries(list.map((c) => [c.adId, c]));
  assert.equal(byAd.A5.campaign, 'CT 01 Col 2 - ventas');
  assert.equal(byAd.A2.campaign, 'CT 01 Col 2');
  assert.equal(byAd[''].campaign, 'Sin anuncio');
});

test('there are no CT issues: any name is a valid campaign', () => {
  const r = run();
  assert.equal(r.ctIssues, undefined);
  assert.equal(r.rows.some((x) => x.ctIssue), false);
});
