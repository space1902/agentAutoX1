import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { lookbackPlan, redact, runSync } from './sync.js';
import { createStore } from './store.js';

const TOKEN = 'EAAB-secret-token-1234567890';

const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const text = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => ({}), text: async () => body });

const insightRow = (date, adId, spend, convs) => ({
  date_start: date, date_stop: date, ad_id: adId, ad_name: `Ad ${adId}`, campaign_id: 'c1', campaign_name: 'CT01 - ventas',
  adset_id: 's1', adset_name: 'Set', spend: String(spend), impressions: '1000', clicks: '40',
  actions: [{ action_type: 'link_click', value: '40' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(convs) }],
});

const SHEET = [
  '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Fecha comprobante","Flujo","ID anuncio","URL anuncio"',
  '"28/10/2026 10:00:00","Pago válido","573001234567","Ana","15.000","Nequi","Ana","28/10/2026 09:58","Bebidas - aporte","A","u"',
  '"28/10/2026 11:00:00","PRUEBA - borrar","573001234567","Ana","15.000","Nequi","Ana","28/10/2026 10:58","Bebidas - aporte","A","u"',
].join('\n');

function fakeFetch({ requests = [], failMeta = null, failSheet = false, emptySheet = false, headerCheck } = {}) {
  return async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') return failSheet ? text('nope', 404) : text(emptySheet ? SHEET.split(String.fromCharCode(10))[0] : SHEET);
    if (headerCheck) headerCheck(init.headers);
    if (failMeta) return json({ error: failMeta }, 400);
    if (u.pathname.endsWith('/insights')) {
      if (!u.searchParams.get('after')) {
        const next = `https://graph.facebook.com${u.pathname}?after=p2&${u.searchParams.toString()}`;
        return json({ data: [insightRow('2026-10-28', 'A', 20000, 40)], paging: { next } });
      }
      return json({ data: [insightRow('2026-10-29', 'A', 5000, 5)] });
    }
    if (u.pathname.endsWith('/ads')) {
      return json({
        data: [{
          id: 'A', name: 'Ad A', created_time: '2026-10-25T10:00:00-0500', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1',
          campaign: { name: 'CT01 - ventas', id: 'c1' }, adset: { name: 'Set', id: 's1', daily_budget: '5000000' },
        }],
      });
    }
    return json({ name: 'X1 Pro Max', timezone_name: 'America/Bogota', currency: 'COP', account_status: 1 });
  };
}

const base = { config: DEFAULT_CONFIG, token: TOKEN, from: '2026-10-28', to: '2026-10-29', now: () => Date.parse('2026-10-29T15:00:00Z') };

test('runSync pulls insights (paginated), ads, budgets and the sheet into the store', async () => {
  const store = createStore();
  const requests = [];
  const out = await runSync({ ...base, store, fetchImpl: fakeFetch({ requests }) });

  assert.equal(out.meta.ok, true);
  assert.equal(out.meta.insightRows, 2);
  assert.equal(out.sheet.ok, true);
  assert.equal(out.sheet.rows, 1);
  assert.equal(out.sheet.skippedTests, 1);

  const insights = store.insightsBetween('2026-10-28', '2026-10-29');
  assert.deepEqual(insights.map((r) => [r.date, r.gasto, r.mensajes]), [['2026-10-28', 20000, 40], ['2026-10-29', 5000, 5]]);
  assert.equal(store.adsMap().A.effectiveStatus, 'ACTIVE');
  assert.equal(store.budgetHistory('adset', 's1')[0].dailyBudget, 5000000);
  assert.equal(store.comprobantesBetween('2026-10-01', '2026-10-31').length, 1);
  assert.deepEqual(store.getKv('account'), { name: 'X1 Pro Max', timezone: 'America/Bogota', currency: 'COP' });
  assert.equal(store.getKv('lastSync').meta, Date.parse('2026-10-29T15:00:00Z'));

  const insightCall = requests.find((r) => r.url.includes('/insights'));
  assert.match(insightCall.url, /level=ad/);
  assert.match(insightCall.url, /time_increment=1/);
  assert.match(decodeURIComponent(insightCall.url), /"since":"2026-10-28","until":"2026-10-29"/);
});

test('first spend date: looks back once to the creation date and stores day 1 per ad', async () => {
  const store = createStore();
  const requests = [];
  const inner = fakeFetch({ requests });
  let lookbackCalls = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/insights') && JSON.parse(u.searchParams.get('time_range')).since === '2026-10-25') {
      lookbackCalls++;
      return json({ data: [insightRow('2026-10-26', 'A', 3000, 2)] });
    }
    return inner(url, init);
  };
  const run = () => runSync({ ...base, from: '2026-10-28', to: '2026-10-29', store, fetchImpl });
  await run();
  assert.equal(store.adsMap().A.firstSpendDate, '2026-10-26');
  assert.equal(store.firstSpendMap().A, '2026-10-26');
  const lookbacks = () => lookbackCalls;
  assert.equal(lookbacks(), 1);
  await run();
  assert.equal(lookbacks(), 1, 'an ad is looked back only once');
});

test('the token travels only in the Authorization header', async () => {
  const requests = [];
  await runSync({ ...base, store: createStore(), fetchImpl: fakeFetch({ requests }) });
  const meta = requests.filter((r) => r.url.includes('graph.facebook.com'));
  assert.ok(meta.length >= 3);
  for (const r of meta) {
    assert.equal(r.url.includes(TOKEN), false);
    assert.equal(r.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(r.init.method, 'GET');
  }
  assert.equal(requests.filter((r) => r.url.includes('docs.google.com')).every((r) => JSON.stringify(r.init).includes(TOKEN) === false), true);
});

test('syncing twice is idempotent and keeps older days', async () => {
  const store = createStore();
  store.upsertInsights([{ date: '2026-09-01', adId: 'Z', adName: 'Z', campaignId: 'c', campaignName: 'CT09', adsetId: 's', adsetName: 's', gasto: 7, impressions: 1, clicks: 1, mensajes: 1 }], 1);
  await runSync({ ...base, store, fetchImpl: fakeFetch() });
  await runSync({ ...base, store, fetchImpl: fakeFetch() });
  assert.equal(store.counts().insights, 3);
  assert.equal(store.counts().comprobantes, 1);
  assert.equal(store.counts().budgets, 1);
});

test('without a token the sheet still syncs and Meta reports a friendly error', async () => {
  const store = createStore();
  const out = await runSync({ ...base, token: '', store, fetchImpl: fakeFetch() });
  assert.equal(out.meta.ok, false);
  assert.equal(out.meta.code, 'NO_TOKEN');
  assert.match(out.meta.error, /token/i);
  assert.equal(out.sheet.ok, true);
  assert.equal(store.counts().comprobantes, 1);
});

test('an expired token is explained and the secret is never echoed', async () => {
  const store = createStore();
  const out = await runSync({ ...base, store, fetchImpl: fakeFetch({ failMeta: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } }) });
  assert.equal(out.meta.ok, false);
  assert.match(out.meta.error, /Token vencido/);
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
});

test('a sheet failure does not stop Meta and keeps the previous cache', async () => {
  const store = createStore();
  await runSync({ ...base, store, fetchImpl: fakeFetch() });
  const out = await runSync({ ...base, store, fetchImpl: fakeFetch({ failSheet: true }) });
  assert.equal(out.meta.ok, true);
  assert.equal(out.sheet.ok, false);
  assert.match(out.sheet.error, /No se pudo leer la hoja/);
  assert.equal(store.counts().comprobantes, 1);
  assert.match(store.getKv('lastSync').sheetError, /No se pudo leer la hoja/);
});

test('an empty sheet (header only) does not flag every payment as gone and warns instead', async () => {
  const store = createStore();
  await runSync({ ...base, store, fetchImpl: fakeFetch() });
  const out = await runSync({ ...base, store, fetchImpl: fakeFetch({ emptySheet: true }) });
  assert.equal(out.sheet.ok, true);
  assert.equal(out.sheet.rows, 0);
  assert.equal(out.sheet.warning, 'La hoja llegó vacía; no se marcó nada como eliminado.');
  assert.equal(store.comprobantesBetween('2026-10-01', '2026-10-31').filter((c) => c.gone).length, 0);
  assert.equal(store.comprobantesBetween('2026-10-01', '2026-10-31').length, 1);
  const again = await runSync({ ...base, store, fetchImpl: fakeFetch() });
  assert.equal(again.sheet.warning, undefined);
});

test('rate limit errors back off instead of hammering Meta', async () => {
  let now = 1_000_000;
  const calls = [];
  const api = new MetaApi({
    token: TOKEN, now: () => now,
    fetchImpl: async (url) => { calls.push(url); return json({ error: { code: 17, message: 'User request limit reached' } }, 400); },
  });
  await assert.rejects(api.get('/act_1'), (e) => e.code === 17);
  await assert.rejects(api.get('/act_1'), /esperar/);
  assert.equal(calls.length, 1);
  now += 61_000;
  await assert.rejects(api.get('/act_1'), (e) => e.code === 17);
  assert.equal(calls.length, 2);
  assert.match(friendlyMetaError({ code: 17 }), /limitando/);
});

test('redact removes the token from any text', () => {
  assert.equal(redact(`boom ${TOKEN} bam`, TOKEN), 'boom *** bam');
  assert.equal(redact('safe', ''), 'safe');
});

test('lookbackPlan skips ads that started inside the range, already have spend, were checked or are not monitored', () => {
  const ad = (adId, createdTime, campaignName = 'CT01') => ({ adId, createdTime, campaignName });
  const plan = lookbackPlan({
    ads: [ad('1', '2026-10-20T10:00:00-0500'), ad('2', '2026-10-28T10:00:00-0500'), ad('3', '2026-10-10T10:00:00-0500'), ad('4', '2026-10-10T10:00:00-0500'), ad('5', '2026-10-10T10:00:00-0500', 'Branding')],
    first: { 3: '2026-10-11' }, checked: ['4'], from: '2026-10-28', prefix: 'CT', today: '2026-10-29',
  });
  assert.deepEqual(plan, { ids: ['1'], since: '2026-10-20', until: '2026-10-27' });
  assert.equal(lookbackPlan({ ads: [], first: {}, checked: [], from: '2026-10-28', prefix: 'CT', today: '2026-10-29' }), null);
});

test('every sync re-reads the delivery status of the ads (including deleted ones) and stores it', async () => {
  const store = createStore();
  await runSync({ ...base, store, fetchImpl: fakeFetch() });
  assert.equal(store.adsMap().A.effectiveStatus, 'ACTIVE');

  const requests = [];
  const paused = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/ads')) {
      requests.push(u);
      return json({ data: [{ id: 'A', name: 'Ad A', created_time: '2026-10-25T10:00:00-0500', effective_status: 'CAMPAIGN_PAUSED', campaign_id: 'c1', adset_id: 's1', campaign: { name: 'CT01 - ventas', id: 'c1' }, adset: { name: 'Set', id: 's1' } }] });
    }
    return fakeFetch()(url, init);
  };
  const out = await runSync({ ...base, store, fetchImpl: paused });
  assert.equal(out.meta.ok, true);
  assert.equal(store.adsMap().A.effectiveStatus, 'CAMPAIGN_PAUSED');
  assert.equal(store.adsMap().A.campaignName, 'CT01 - ventas');
  // Meta rejects DELETED in this filter (error 100 "Invalid parameter").
  assert.doesNotMatch(requests[0].searchParams.get('effective_status'), /DELETED/);
  assert.match(requests[0].searchParams.get('fields'), /effective_status/);
});
