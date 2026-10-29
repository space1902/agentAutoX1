import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig, DEFAULT_CONFIG } from './config.js';
import { createStore } from './store.js';
import { historyInfo, runAutoSync } from './sync.js';

const TOKEN = 'EAAB-secret-token-1234567890';
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const text = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => body });
const HEADER = '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Fecha comprobante","Flujo","ID anuncio","URL anuncio"';
const sheetRow = (reg, phone, valor, ad = '5255001') => `"${reg}","Pago válido","${phone}","Ana","${valor}","Nequi","Ana","${reg.slice(0, 16)}","Bebidas - aporte","${ad}","u"`;

function world({ sheet, failActivities = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') return text([HEADER, ...(sheet ?? [sheetRow('15/08/2026 10:00:00', '573001234567', '15.000'), sheetRow('28/10/2026 10:00:00', '525512345678', '300')])].join('\n'));
    if (u.pathname.endsWith('/activities')) return failActivities ? json({ error: { code: 200, message: 'no' } }, 403) : json({ data: [] });
    if (u.pathname.endsWith('/insights')) {
      if (u.searchParams.get('level') === 'account') return json({ data: [{ date_start: '2026-10-01', spend: '1000' }, { date_start: '2026-11-01', spend: '0' }] });
      const range = JSON.parse(u.searchParams.get('time_range'));
      const mk = (country, spend) => ({ date_start: range.until, ad_id: '5255001', ad_name: 'Ad', campaign_id: 'c1', campaign_name: 'CT01 Col', adset_id: 's1', adset_name: 'S', country, spend: String(spend), impressions: '10', clicks: '1', actions: [] });
      return json({ data: [mk('CO', 600), mk('MX', 400)] });
    }
    if (u.pathname.endsWith('/ads')) return json({ data: [] });
    return json({ name: 'X1', timezone_name: 'America/Bogota', currency: 'COP' });
  };
  return { fetchImpl, calls };
}
const at = (iso) => () => Date.parse(iso);
const NOW = '2026-10-29T15:00:00Z';
const timeRanges = (calls) => calls.filter((c) => c.includes('/insights') && c.includes('time_range')).map((c) => JSON.parse(new URL(c).searchParams.get('time_range')));

test('first auto sync backfills from the earliest day found, month by month, and remembers it', async () => {
  const store = createStore();
  const w = world();
  const out = await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: at(NOW) });
  assert.equal(out.backfilled, true);
  assert.equal(out.meta.ok, true);
  const ranges = timeRanges(w.calls);
  assert.equal(ranges[0].since, '2026-08-15', 'the sheet starts before Meta');
  assert.equal(ranges.at(-1).until, '2026-10-29');
  assert.ok(ranges.length >= 2, 'chunked');
  assert.ok(ranges.every((r, i) => i === 0 || r.since > ranges[i - 1].until));
  assert.deepEqual(store.getKv('historyStart'), { date: '2026-08-15', source: 'auto' });
  assert.equal(store.getKv('backfillDone').from, '2026-08-15');
  assert.ok(w.calls.some((c) => c.includes('/activities')), 'budget history is backfilled from the activity log');
  assert.equal(out.history.from, '2026-08-15');
  assert.ok(out.history.days >= 2);
});

test('later syncs only refresh the last 3 days plus today', async () => {
  const store = createStore();
  await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world().fetchImpl, now: at(NOW) });
  const w = world();
  const out = await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: w.fetchImpl, now: at('2026-10-30T15:00:00Z') });
  assert.equal(out.backfilled, false);
  assert.deepEqual(timeRanges(w.calls), [{ since: '2026-10-27', until: '2026-10-30' }]);
  assert.equal(w.calls.some((c) => c.includes('level=account')), false);
});

test('asking for an earlier "Historial desde" triggers a new backfill from that day', async () => {
  const store = createStore();
  await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world().fetchImpl, now: at(NOW) });
  const w = world();
  const out = await runAutoSync({ store, config: mergeConfig({ historyFrom: '2026-07-01' }), token: TOKEN, fetchImpl: w.fetchImpl, now: at(NOW) });
  assert.equal(out.backfilled, true);
  assert.equal(timeRanges(w.calls)[0].since, '2026-07-01');
  assert.equal(store.getKv('historyStart').source, 'config');
});

test('spend keeps the country split and totals stay consistent', async () => {
  const store = createStore();
  await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world().fetchImpl, now: at(NOW) });
  const rows = store.insightsBetween('2026-10-29', '2026-10-29');
  assert.deepEqual(rows.map((r) => [r.country, r.gasto]).sort(), [['CO', 600], ['MX', 400]]);
});

test('payment countries are derived and stored after the sync', async () => {
  const store = createStore();
  await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world().fetchImpl, now: at(NOW) });
  const byDate = Object.fromEntries(store.comprobantesBetween('2026-08-01', '2026-10-31').map((c) => [c.date, [c.country, c.countrySource]]));
  assert.deepEqual(byDate['2026-08-15'], ['CO', 'telefono']);
  assert.deepEqual(byDate['2026-10-28'], ['MX', 'telefono']);
});

test('payments that disappear from the sheet stay in the history', async () => {
  const store = createStore();
  await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world().fetchImpl, now: at(NOW) });
  await runAutoSync({ store, config: DEFAULT_CONFIG, token: TOKEN, fetchImpl: world({ sheet: [sheetRow('28/10/2026 10:00:00', '525512345678', '300')] }).fetchImpl, now: at(NOW) });
  const rows = store.comprobantesBetween('2026-08-01', '2026-10-31');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.date === '2026-08-15').gone, true);
});

test('without a token the sheet history still builds and no backfill is marked done', async () => {
  const store = createStore();
  const out = await runAutoSync({ store, config: DEFAULT_CONFIG, token: '', fetchImpl: world().fetchImpl, now: at(NOW) });
  assert.equal(out.meta.ok, false);
  assert.equal(store.getKv('backfillDone'), null);
  assert.equal(out.sheet.ok, true);
  assert.equal(historyInfo(store).vouchers, 2);
});

test('Meta\'s "unknown" country is stored as no country', async () => {
  const { parseInsightRow } = await import('./meta-data.js');
  assert.equal(parseInsightRow({ date_start: '2026-10-29', ad_id: '1', country: 'unknown', spend: '5' }).country, '');
  assert.equal(parseInsightRow({ date_start: '2026-10-29', ad_id: '1', country: 'MX', spend: '5' }).country, 'MX');
});
