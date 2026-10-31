import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AdsError, parseArgs, runAdsCommand } from './ads-api.js';

const TOKEN = 'EAAB-secret-token-1234567890';
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const text = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => body });

const SHEET = [
  '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Fecha comprobante","Flujo","ID anuncio","URL anuncio"',
  '"28/10/2026 10:00:00","Pago válido","573001234567","Ana","60.000","Nequi","Ana","28/10/2026 09:58","Bebidas - aporte","5255001","u"',
  '"28/10/2026 11:00:00","Comprobante inválido","573009998888","Luis","15.000","Nequi","Luis","28/10/2026 10:58","Bebidas - aporte","5255001","u"',
].join('\n');

const fetchImpl = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'docs.google.com') return text(SHEET);
  if (u.pathname.endsWith('/insights')) {
    return json({
      data: [{ date_start: '2026-10-28', ad_id: '5255001', ad_name: 'Video 1', campaign_id: 'c1', campaign_name: 'CT01 - ventas', adset_id: 's1', adset_name: 'S', spend: '20000', impressions: '10', clicks: '1',
        actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '40' }] }],
    });
  }
  if (u.pathname.endsWith('/ads')) return json({ data: [{ id: '5255001', name: 'Video 1', created_time: '2026-10-25T10:00:00-0500', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', campaign: { name: 'CT01 - ventas' }, adset: { name: 'S', daily_budget: '1000' } }] });
  return json({ name: 'X1 Pro Max', timezone_name: 'America/Bogota', currency: 'COP', account_status: 1 });
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ads-api-'));
const ctx = (extra = {}) => ({ dataDir: tmp(), env: { AGENTAUTO_META_TOKEN: TOKEN }, fetchImpl, now: () => Date.parse('2026-10-29T15:00:00Z'), ...extra });

test('parseArgs reads --flag value pairs and --stdin', () => {
  assert.deepEqual(parseArgs(['--from', '2026-10-01', '--to', '2026-10-02', '--group', 'ad']), { from: '2026-10-01', to: '2026-10-02', group: 'ad' });
  assert.equal(parseArgs(['--stdin']).stdin, true);
  assert.deepEqual(parseArgs([]), {});
});

test('sync then report returns KPIs, rows with actions, daily series and masked comprobantes', async () => {
  const c = ctx();
  const sync = await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-29' }, c);
  assert.equal(sync.meta.ok, true);
  assert.equal(sync.sheet.ok, true);

  const report = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ct' }, c);
  assert.equal(report.kpis.gasto, 20000);
  assert.equal(report.kpis.valor, 60000);
  assert.equal(report.kpis.roas, 3);
  assert.equal(report.rows[0].label, 'CT 01');
  assert.equal(report.rows[0].action.label, 'Escalar');
  assert.equal(report.rows[0].ageDays, 2); // first spend 2026-10-28 = day 1
  assert.equal(report.rows[0].firstSpendDate, '2026-10-28');
  assert.equal(report.comprobantes.length, 2);
  assert.equal(report.reviewCount, 1);
  assert.ok(report.comprobantes.some((c) => c.phone === '573001234567' && c.phoneMasked === '••••4567'));
  assert.equal(report.today, '2026-10-29');
  assert.equal(report.lastSync.meta, Date.parse('2026-10-29T15:00:00Z'));
  assert.equal(report.currency, 'COP');
});

test('report works from the cache with no token and no network', async () => {
  const dir = tmp();
  await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-28' }, ctx({ dataDir: dir }));
  const offline = { dataDir: dir, env: {}, fetchImpl: async () => { throw new Error('no network'); }, now: () => Date.parse('2026-10-29T15:00:00Z') };
  const report = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-28', group: 'ad' }, offline);
  assert.equal(report.rows[0].adId, '5255001');
});

test('report honours config changes without re-syncing', async () => {
  const c = ctx();
  await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-28' }, c);
  await runAdsCommand('config-set', { campaignPrefix: 'ZZ' }, c);
  const report = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-28', group: 'ct' }, c);
  assert.equal(report.kpis.gasto, 0);
});

test('status reports token presence, counts and last sync without leaking the token', async () => {
  const c = ctx();
  assert.equal((await runAdsCommand('status', {}, c)).tokenPresent, true);
  await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-28' }, c);
  const status = await runAdsCommand('status', {}, c);
  assert.equal(status.counts.insights, 1);
  assert.equal(status.lastSync.sheet, Date.parse('2026-10-29T15:00:00Z'));
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  assert.equal((await runAdsCommand('status', {}, ctx({ env: {} }))).tokenPresent, false);
});

test('test-token verifies access to the ad account', async () => {
  const out = await runAdsCommand('test-token', {}, ctx());
  assert.deepEqual(out, { accountName: 'X1 Pro Max', currency: 'COP', timezone: 'America/Bogota' });
  await assert.rejects(runAdsCommand('test-token', {}, ctx({ env: {} })), /token/i);
});

test('config-get returns config and defaults; config-set validates', async () => {
  const c = ctx();
  const got = await runAdsCommand('config-get', {}, c);
  assert.equal(got.config.flowPrefix, 'Bebidas');
  assert.equal(got.defaults.flowPrefix, 'Bebidas');
  const set = await runAdsCommand('config-set', { flowPrefix: 'Barf' }, c);
  assert.equal(set.config.flowPrefix, 'Barf');
  await assert.rejects(runAdsCommand('config-set', { adAccountId: 'nope' }, c), AdsError);
  await assert.rejects(runAdsCommand('config-set', { token: 'x' }, c), /token/i);
});

test('dates and commands are validated', async () => {
  const c = ctx();
  await assert.rejects(runAdsCommand('sync', { from: '2026-10-30', to: '2026-10-01' }, c), /rango/i);
  await assert.rejects(runAdsCommand('report', { from: 'ayer', to: 'hoy' }, c), /fecha/i);
  await assert.rejects(runAdsCommand('sync', { from: '2024-01-01', to: '2026-10-01' }, c), /rango/i);
  await assert.rejects(runAdsCommand('report', { from: '2026-10-01', to: '2026-10-02', group: 'x' }, c), /agrupaci/i);
  await assert.rejects(runAdsCommand('rm -rf', {}, c), /comando/i);
});

test('tick, decisions and decision-status work through the command layer', async () => {
  const c = ctx();
  const tick = await runAdsCommand('tick', {}, c);
  assert.equal(tick.snapshot, true);
  assert.deepEqual(tick.created, []);
  const list = await runAdsCommand('decisions', {}, c);
  assert.deepEqual(list.decisions, []);
  assert.equal(list.lifecycle.testNotifyDay, 4);
  await assert.rejects(runAdsCommand('decision-status', { id: '1', status: 'done' }, c), /No encuentro/);
  await assert.rejects(runAdsCommand('decision-status', { id: 'x', status: 'done' }, c), AdsError);
  await assert.rejects(runAdsCommand('decision-status', { id: '1', status: 'borrar' }, c), AdsError);
});

test('alerts commands: config round trip, wa status and an empty alert list', async () => {
  const c = ctx();
  const got = await runAdsCommand('alerts-config-get', {}, c);
  assert.equal(got.config.allowActions, false);
  assert.equal(got.defaults.pollMinutes, 15);
  const set = await runAdsCommand('alerts-config-set', { pollMinutes: 20, whatsapp: { alertTo: '316 758 5233' } }, c);
  assert.equal(set.config.pollMinutes, 20);
  assert.equal(set.config.whatsapp.alertTo, '573167585233');
  await assert.rejects(runAdsCommand('alerts-config-set', { thresholds: { targetCpa: 99999999 } }, c), AdsError);
  assert.deepEqual(await runAdsCommand('wa-status', {}, c), { linked: false, phoneMasked: '' });
  assert.deepEqual(await runAdsCommand('alerts-recent', {}, c), { alerts: [], pausedUntil: null });
});

test('sync --auto, tracking, country filter and the manual country override work through the command layer', async () => {
  const c = ctx();
  const sync = await runAdsCommand('sync', { auto: true }, c);
  assert.equal(sync.backfilled, true);
  assert.ok(sync.history.days >= 1);
  const status = await runAdsCommand('status', {}, c);
  assert.equal(status.history.backfill.from, sync.history.from);

  const tracking = await runAdsCommand('tracking', {}, c);
  assert.equal(Array.isArray(tracking.items), true);

  const report = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ct', country: 'CO', split: 'true' }, c);
  assert.equal(report.country, 'CO');
  assert.ok(report.countries.length >= 1);
  assert.ok(report.history.days >= 1);
  await assert.rejects(runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', country: 'Mexico' }, c), /país/i);

  const key = report.comprobantes[0]?.key;
  if (key) {
    const set = await runAdsCommand('comprobante-country', { key, code: 'CO' }, c);
    assert.equal(set.country, 'CO');
    const again = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ct' }, c);
    assert.equal(again.comprobantes.find((v) => v.key === key).countrySource, 'manual');
  }
  await assert.rejects(runAdsCommand('comprobante-country', { key: 'nope', code: 'MX' }, c), AdsError);
});

test('vouchers returns the same list as the report for any range, from the cache and without Meta rows', async () => {
  const dir = tmp();
  await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-28' }, ctx({ dataDir: dir }));
  const offline = { dataDir: dir, env: {}, fetchImpl: async () => { throw new Error('no network'); }, now: () => Date.parse('2026-10-29T15:00:00Z') };
  const report = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-28', group: 'ct' }, offline);
  const v = await runAdsCommand('vouchers', { from: '2026-10-28', to: '2026-10-28' }, offline);
  assert.deepEqual(v.range, { from: '2026-10-28', to: '2026-10-28' });
  assert.deepEqual(v.comprobantes, report.comprobantes);
  assert.equal(v.reviewCount, report.reviewCount);
  assert.equal(v.comprobantes[0].phone, '573001234567', 'the Comprobantes card shows the full phone');
  // A range with no payments is simply empty; a wide range keeps the same two.
  assert.equal((await runAdsCommand('vouchers', { from: '2026-10-01', to: '2026-10-27' }, offline)).comprobantes.length, 0);
  assert.equal((await runAdsCommand('vouchers', { from: '2026-10-01', to: '2026-10-29' }, offline)).comprobantes.length, 2);
  await assert.rejects(runAdsCommand('vouchers', { from: 'ayer', to: 'hoy' }, offline), /fecha/i);
  await assert.rejects(runAdsCommand('vouchers', { from: '2026-10-01', to: '2026-10-02', country: 'xx' }, offline), /país/i);
});
