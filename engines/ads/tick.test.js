import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { createStore } from './store.js';
import { runTick } from './tick.js';

const TOKEN = 'EAAB-secret-token-1234567890';
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const text = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => body });

const insightRow = (date, adId, spend) => ({
  date_start: date, ad_id: adId, ad_name: `Ad ${adId}`, campaign_id: 'c1', campaign_name: 'CT01 - ventas', adset_id: 's1', adset_name: 'Set 1',
  spend: String(spend), impressions: '100', clicks: '5', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '10' }],
});
const HEADER = '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Fecha comprobante","Flujo","ID anuncio","URL anuncio"';
const sheetRow = (date, valor) => `"${date} 10:00:00","Pago válido","573001234567","Ana","${valor}","Nequi","Ana","${date} 09:58","Bebidas - aporte","5255001","u"`;

function world({ activities = [], dailyBudget = '5000000', failActivities = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') {
      return text([HEADER, sheetRow('26/10/2026', '60.000'), sheetRow('27/10/2026', '60.000'), sheetRow('28/10/2026', '60.000')].join('\n'));
    }
    if (u.pathname.endsWith('/activities')) return failActivities ? json({ error: { code: 200, message: 'no' } }, 403) : json({ data: activities });
    if (u.pathname.endsWith('/insights')) return json({ data: ['25', '26', '27', '28'].map((d) => insightRow(`2026-10-${d}`, '5255001', 10000)) });
    if (u.pathname.endsWith('/ads')) {
      return json({ data: [{ id: '5255001', name: 'Ad 5255001', created_time: '2026-10-25T08:00:00-0500', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', campaign: { name: 'CT01 - ventas' }, adset: { name: 'Set 1', daily_budget: dailyBudget } }] });
    }
    return json({ name: 'X1', timezone_name: 'America/Bogota', currency: 'COP' });
  };
  return { fetchImpl, calls };
}

// 2026-10-28 20:05 in Bogota = 2026-10-29 01:05Z
const at = (iso) => () => Date.parse(iso);
const DAY4_2005 = '2026-10-29T01:05:00Z';

test('first tick snapshots budgets, reads activities and creates nothing when nothing is due', async () => {
  const store = createStore();
  const w = world();
  const out = await runTick({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: at('2026-10-28T15:00:00Z') });
  assert.equal(out.snapshot, true);
  assert.equal(out.created.length, 0);
  assert.equal(store.budgetHistory('adset', 's1').length, 1);
  assert.ok(w.calls.some((c) => c.includes('/activities')));
  assert.equal(w.calls.some((c) => c.includes('docs.google.com')), false, 'no sync when nothing is due');
});

test('snapshots are throttled to every snapshotMinutes', async () => {
  const store = createStore();
  const w = world();
  let t = Date.parse('2026-10-28T15:00:00Z');
  await runTick({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: () => t });
  const before = w.calls.length;
  t += 10 * 60_000;
  const again = await runTick({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: () => t });
  assert.equal(again.snapshot, false);
  assert.equal(w.calls.length, before);
  t += 25 * 60_000;
  assert.equal((await runTick({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: () => t })).snapshot, true);
});

test('a due decision triggers a sync, is stored once and is queued for WhatsApp when enabled', async () => {
  const store = createStore();
  const config = mergeConfig({ lifecycle: { notifyWhatsapp: true } });
  const w = world();
  // Day 1 of the ad is already known (first spend 2026-10-25).
  store.upsertInsights([{ date: '2026-10-25', adId: '5255001', adName: 'Ad 5255001', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's1', adsetName: 'Set 1', gasto: 10000, impressions: 1, clicks: 1, mensajes: 10 }], 1);
  store.upsertAds([{ adId: '5255001', name: 'Ad', createdTime: '2026-10-25T08:00:00-0500', effectiveStatus: 'ACTIVE', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's1', adsetName: 'Set 1' }], 1);
  store.refreshFirstSpend();

  const out = await runTick({ store, config, token: TOKEN, fetchImpl: w.fetchImpl, now: at(DAY4_2005) });
  assert.equal(out.synced, true);
  assert.ok(out.created.length >= 2, 'ad and CT verdicts');
  const ad = out.created.find((d) => d.kind === 'test');
  assert.equal(ad.verdict.label, 'Escalar y duplicar');
  assert.ok(ad.id > 0);
  assert.equal(store.decisions().length, out.created.length);
  assert.equal(store.pendingWhatsapp().length, out.created.length);
  assert.match(store.pendingWhatsapp()[0].text, /día 4/);

  const again = await runTick({ store, config, token: TOKEN, fetchImpl: w.fetchImpl, now: at('2026-10-29T01:10:00Z') });
  assert.equal(again.created.length, 0);
  assert.equal(store.decisions().length, out.created.length);
});

test('without a token it still evaluates from the cache (catch-up) and never calls the network', async () => {
  const store = createStore();
  const w = world();
  // Seed the cache through a normal run, then evaluate the next morning without a token.
  await runTick({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: at('2026-10-28T15:00:00Z') });
  const sync = await import('./sync.js');
  await sync.runSync({ store, config: DEFAULT_CONFIG, token: TOKEN, from: '2026-10-25', to: '2026-10-28', fetchImpl: w.fetchImpl, now: at('2026-10-28T15:00:00Z') });
  const offline = world();
  const out = await runTick({ store, config: DEFAULT_CONFIG, token: '', fetchImpl: offline.fetchImpl, now: at('2026-10-29T14:00:00Z') });
  assert.equal(offline.calls.length, 0);
  assert.ok(out.created.length >= 1);
  assert.equal(out.created.every((d) => d.late), true);
});

test('a raise found in the activity log is dated exactly and evaluated on day 2', async () => {
  const store = createStore();
  const activities = [{ event_type: 'update_ad_set_budget', object_id: 's1', event_time: '2026-10-27T15:30:00+0000', extra_data: JSON.stringify({ old_value: '4000000', new_value: '5000000' }) }];
  const w = world({ activities });
  const config = mergeConfig({ lifecycle: { testEnabled: false } });
  const out = await runTick({ store, config, token: TOKEN, fetchImpl: w.fetchImpl, now: at(DAY4_2005) });
  const b = out.created.find((d) => d.kind === 'budget');
  assert.ok(b, 'budget decision created');
  assert.equal(b.extra.exact, true);
  assert.equal(b.extra.changeDate, '2026-10-27');
  assert.equal(b.dayN, 2);
});

test('an activity log failure does not break the tick (snapshots are the fallback)', async () => {
  const store = createStore();
  const out = await runTick({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world({ failActivities: true }).fetchImpl, now: at('2026-10-28T15:00:00Z') });
  assert.equal(out.snapshot, true);
  assert.equal(store.budgetHistory('adset', 's1').length, 1);
  assert.match(out.warnings.join(' '), /actividad/i);
});
