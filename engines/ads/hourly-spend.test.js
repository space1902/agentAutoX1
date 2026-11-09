// Hourly spend: Meta parsing + timezone shift, storage, the single extra request per account, IVA, hour ranges and ROAS.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { HOURLY_BREAKDOWN, fetchHourlyInsights, parseHourBucket, parseHourlyRow } from './meta-data.js';
import { buildReport } from './report.js';
import { createStore } from './store.js';
import { runSync } from './sync.js';
import { convertHour } from './time.js';

const BOGOTA = 'America/Bogota';
const TOKEN = 'EAAB-secret-token-1234567890';

const metaRow = (date, bucketText, spend, adId = 'A') => ({
  date_start: date, hourly_stats_aggregated_by_advertiser_time_zone: bucketText, ad_id: adId, ad_name: `Ad ${adId}`, campaign_id: 'c1', campaign_name: 'CT01 - ventas',
  adset_id: 's1', adset_name: 'S', spend: String(spend),
});
const bucket = (h) => `${String(h).padStart(2, '0')}:00:00 - ${String(h).padStart(2, '0')}:59:59`;

test('parseHourBucket reads the start hour of the Meta bucket text', () => {
  assert.equal(parseHourBucket('08:00:00 - 08:59:59'), 8);
  assert.equal(parseHourBucket('00:00:00 - 00:59:59'), 0);
  assert.equal(parseHourBucket('23:00:00 - 23:59:59'), 23);
  assert.equal(parseHourBucket('nonsense'), null);
  assert.equal(parseHourBucket(undefined), null);
});

test('convertHour shifts the hour (and the day) between timezones', () => {
  assert.deepEqual(convertHour('2026-10-28', 8, BOGOTA, BOGOTA), { date: '2026-10-28', hour: 8 });
  // New York is UTC-4 in October (DST), Bogota UTC-5: one hour earlier, and midnight goes to the previous day.
  assert.deepEqual(convertHour('2026-10-28', 8, 'America/New_York', BOGOTA), { date: '2026-10-28', hour: 7 });
  assert.deepEqual(convertHour('2026-10-28', 0, 'America/New_York', BOGOTA), { date: '2026-10-27', hour: 23 });
  // Mexico City is UTC-6: one hour later, and 23:00 goes to the next day.
  assert.deepEqual(convertHour('2026-10-28', 8, 'America/Mexico_City', BOGOTA), { date: '2026-10-28', hour: 9 });
  assert.deepEqual(convertHour('2026-10-28', 23, 'America/Mexico_City', BOGOTA), { date: '2026-10-29', hour: 0 });
  // Half-hour zone (India, UTC+5:30): the Bogota hour that contains the start of the source hour.
  assert.deepEqual(convertHour('2026-10-28', 10, 'Asia/Kolkata', BOGOTA), { date: '2026-10-27', hour: 23 });
});

test('parseHourlyRow keeps the Meta values and the shifted Bogota hour; unusable rows are dropped', () => {
  const r = parseHourlyRow(metaRow('2026-10-28', bucket(0), 1234.5), { accountTz: 'America/New_York', reportTz: BOGOTA });
  assert.deepEqual([r.srcDate, r.srcHour, r.date, r.hour, r.gasto, r.adId], ['2026-10-28', 0, '2026-10-27', 23, 1234.5, 'A']);
  assert.equal(parseHourlyRow(metaRow('2026-10-28', 'bad', 1), { accountTz: BOGOTA, reportTz: BOGOTA }), null);
  assert.equal(parseHourlyRow({ ...metaRow('2026-10-28', bucket(3), 1), ad_id: '' }, { accountTz: BOGOTA, reportTz: BOGOTA }), null);
});

test('fetchHourlyInsights asks Meta for ad-level hourly spend, one paginated request per 31 days', async () => {
  const seen = [];
  const api = { getAll: async (path, params) => { seen.push({ path, params }); return [metaRow('2026-10-28', bucket(9), 10)]; } };
  const rows = await fetchHourlyInsights(api, 'act_1', '2026-10-25', '2026-10-28', { accountTz: BOGOTA, reportTz: BOGOTA });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/act_1/insights');
  assert.equal(seen[0].params.level, 'ad');
  assert.equal(seen[0].params.breakdowns, HOURLY_BREAKDOWN);
  assert.equal(seen[0].params.time_increment, 1);
  assert.equal(seen[0].params.fields, 'campaign_name,campaign_id,adset_id,adset_name,ad_id,ad_name,spend');
  assert.equal(rows.length, 1);
});

test('the store replaces the hours of a re-synced day and returns them by Bogota day', () => {
  const store = createStore();
  const parse = (date, h, spend) => parseHourlyRow(metaRow(date, bucket(h), spend), { accountTz: 'America/Mexico_City', reportTz: BOGOTA });
  store.upsertHourlyInsights([parse('2026-10-28', 8, 100), parse('2026-10-28', 23, 50)], 1, 'act_1');
  store.upsertHourlyInsights([parse('2026-10-28', 8, 120)], 2, 'act_1');
  const rows = store.hourlyBetween('2026-10-28', '2026-10-29');
  assert.deepEqual(rows.map((r) => [r.date, r.hour, r.gasto, r.accountId]), [['2026-10-28', 9, 120, 'act_1']], 'the 23:00 row of the same day was replaced');
  assert.equal(store.hourlyBetween('2026-10-29', '2026-10-29').length, 0);
});

function world({ hourlyFails = false } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
    if (u.pathname.endsWith('/insights')) {
      if (u.searchParams.get('breakdowns')?.startsWith('hourly')) {
        return hourlyFails ? json({ error: { code: 100, message: 'nope' } }, 400) : json({ data: [metaRow('2026-10-28', bucket(9), 1000), metaRow('2026-10-28', bucket(10), 500)] });
      }
      return json({ data: [{ date_start: '2026-10-28', ad_id: 'A', ad_name: 'Ad A', campaign_id: 'c1', campaign_name: 'CT01 - ventas', adset_id: 's1', adset_name: 'S', country: 'CO', spend: '1500', impressions: '1', clicks: '1', actions: [] }] });
    }
    if (u.pathname.endsWith('/ads')) return json({ data: [] });
    return json({ name: 'X1', timezone_name: 'America/Bogota', currency: 'COP' });
  };
  return { fetchImpl, calls };
}
const NOW = () => Date.parse('2026-10-28T20:00:00Z');

test('a sync stores hourly spend with exactly one extra insights request per account', async () => {
  const store = createStore();
  const w = world();
  const out = await runSync({ store, config: DEFAULT_CONFIG, token: TOKEN, from: '2026-10-25', to: '2026-10-28', fetchImpl: w.fetchImpl, now: NOW });
  assert.equal(out.meta.ok, true);
  const hourlyCalls = w.calls.filter((c) => c.includes('hourly_stats_aggregated_by_advertiser_time_zone'));
  assert.equal(hourlyCalls.length, 1);
  assert.ok(!hourlyCalls[0].includes('DELETED'));
  assert.ok(!hourlyCalls.join('').includes(TOKEN), 'the token travels in a header, never in the URL');
  assert.deepEqual(store.hourlyBetween('2026-10-28', '2026-10-28').map((r) => [r.hour, r.gasto]), [[9, 1000], [10, 500]]);
});

test('a long manual range only asks hourly spend for the most recent 7 days', async () => {
  const store = createStore();
  const w = world();
  await runSync({ store, config: DEFAULT_CONFIG, token: TOKEN, from: '2026-09-01', to: '2026-10-28', fetchImpl: w.fetchImpl, now: NOW });
  const range = JSON.parse(new URL(w.calls.find((c) => c.includes('hourly_stats'))).searchParams.get('time_range'));
  assert.deepEqual(range, { since: '2026-10-22', until: '2026-10-28' });
});

test('a failing hourly request never fails the account: daily data is kept', async () => {
  const store = createStore();
  const out = await runSync({ store, config: DEFAULT_CONFIG, token: TOKEN, from: '2026-10-28', to: '2026-10-28', fetchImpl: world({ hourlyFails: true }).fetchImpl, now: NOW });
  assert.equal(out.meta.ok, true);
  assert.equal(store.insightsBetween('2026-10-28', '2026-10-28').length, 1);
  assert.equal(store.hourlyBetween('2026-10-28', '2026-10-28').length, 0);
});

// ---- report
const config = mergeConfig({ spendVatPct: 19, currency: 'COP', enabledCountries: ['CO'] });
const day = '2026-10-28';
const insights = [{ date: day, adId: 'A', adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's', adsetName: 'S', gasto: 1000, mensajes: 9, country: 'CO', accountId: '' }];
// 100 net per hour for hours 0..9 (total 1000).
const hourlyInsights = Array.from({ length: 10 }, (_, h) => ({ date: day, hour: h, adId: 'A', adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's', adsetName: 'S', gasto: 100, accountId: '' }));
const pay = (hhmm, n, valor) => ({ key: `k${n}`, registered: `28/10/2026 ${hhmm}:00`, date: day, result: 'Pago válido', phone: `57300000000${n}`, valor, bank: 'X', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '', country: 'CO', countrySource: 'telefono', gone: false });
const comprobantes = [pay('07:10', 1, 1000), pay('08:05', 2, 2000), pay('11:59', 3, 3000), pay('12:00', 4, 4000)];
const identities = { A: { adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas' } };
const run = (over = {}) => buildReport({ insights, hourlyInsights, comprobantes, identities, config, from: day, to: day, today: '2026-10-29', ...over });

test('hourly spend carries the IVA like the daily spend; ROAS per hour uses the net spend', () => {
  const r = run();
  const h8 = r.hourly[8];
  assert.equal(h8.spendNet, 100);
  assert.ok(Math.abs(h8.vat - 19) < 1e-9);
  assert.ok(Math.abs(h8.gasto - 119) < 1e-9);
  assert.equal(h8.valor, 2000);
  assert.equal(h8.roas, 2000 / 100, 'ROAS never includes the IVA');
  assert.equal(r.hourly[15].gasto, 0);
  assert.deepEqual(r.hourlySpend, { level: 'ad', available: true, daysMissing: 0 });
});

test('hours 8-12 include 8, 9, 10 and 11: spend and sales are counted only for those hours', () => {
  const r = run({ hours: { start: 8, end: 12 } });
  // Hourly spend exists for hours 0-9 only, so the range holds hours 8 and 9 = 200 net.
  assert.ok(Math.abs(r.kpis.spendNet - 200) < 1e-9);
  assert.ok(Math.abs(r.kpis.gasto - 238) < 1e-9, 'IVA applied to the range spend');
  assert.equal(r.kpis.ventas, 2, '08:05 and 11:59 count; 07:10 and 12:00 do not');
  assert.equal(r.kpis.valor, 5000);
  assert.equal(r.kpis.roas, 5000 / 200, 'ROAS in the range = value / net spend of those hours');
  assert.equal(r.kpis.mensajes, null);
  assert.equal(r.kpis.costoMensaje, null);
  assert.equal(r.notes.some((n) => n.code === 'hourly_spend_missing'), false);
  assert.equal(r.hourly.length, 24, 'the chart keeps every hour');
  assert.ok(Math.abs(r.hourly[8].gasto - 119) < 1e-9);
  assert.equal(r.rows[0].action, null, 'row decisions stay N/D with a schedule');
  assert.ok(Math.abs(r.daily[0].spendNet - 200) < 1e-9);
});

test('an end hour of 24 and a window across midnight work on spend too', () => {
  assert.ok(Math.abs(run({ hours: { start: 0, end: 24 } }).kpis.spendNet - 1000) < 1e-9);
  const wrap = run({ hours: { start: 22, end: 3 } });
  assert.ok(Math.abs(wrap.kpis.spendNet - 300) < 1e-9, 'hours 0, 1 and 2');
});

test('a day without hourly spend keeps its whole-day spend and the report says so', () => {
  const r = run({ hourlyInsights: [], hours: { start: 8, end: 12 } });
  assert.equal(r.kpis.spendNet, 1000);
  assert.equal(r.notes.find((n) => n.code === 'hourly_spend_missing').count, 1);
  assert.equal(r.hourlySpend.available, false);
  assert.equal(r.hourlySpend.daysMissing, 1);
});

test('hourly spend follows the country filter by the daily country share of the ad, and the name filter', () => {
  const split = [
    { ...insights[0], gasto: 600, country: 'CO' },
    { ...insights[0], gasto: 400, country: 'MX' },
  ];
  const cfg = mergeConfig({ spendVatPct: 0, currency: 'COP', enabledCountries: ['CO', 'MX'] });
  const co = run({ insights: split, config: cfg, country: 'CO' });
  assert.ok(Math.abs(co.hourly[8].spendNet - 60) < 1e-9, '60% of the hour');
  const mx = run({ insights: split, config: cfg, country: 'MX', hours: { start: 8, end: 12 } });
  assert.ok(Math.abs(mx.kpis.spendNet - 80) < 1e-9);
  const none = run({ names: ['zzz'] });
  assert.equal(none.hourly[8].gasto, 0, 'a name filter that matches nothing leaves no hourly spend');
});

test('each real campaign gets its own hourly series for the chart selector', () => {
  const other = { ...hourlyInsights[0], adId: 'B', campaignId: 'c2', campaignName: 'CT02 - otra', gasto: 40 };
  const r = run({
    hourlyInsights: [...hourlyInsights, other],
    insights: [...insights, { ...insights[0], adId: 'B', campaignId: 'c2', campaignName: 'CT02 - otra', gasto: 40 }],
    identities: { ...identities, B: { adName: 'Ad B', campaignId: 'c2', campaignName: 'CT02 - otra' } },
  });
  const byKey = Object.fromEntries(r.campaignHourly.map((c) => [c.key, c.hourly]));
  assert.equal(byKey.c1[0].spendNet, 100);
  assert.equal(byKey.c2[0].spendNet, 40);
  assert.equal(r.hourly[0].spendNet, 140, 'the all-campaigns series is the sum');
  assert.equal(byKey.c1[8].ventas, 1);
});
