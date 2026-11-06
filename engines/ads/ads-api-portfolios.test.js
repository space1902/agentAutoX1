import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AdsError, runAdsCommand } from './ads-api.js';
import { loadConfig, saveConfig } from './config.js';

const T1 = 'EAAB-token-principal-1234567890';
const T2 = 'EAAB-token-segundo-bm-0987654321';
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const text = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => body });
const HEADER = '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Fecha comprobante","Flujo","ID anuncio","URL anuncio"';
const SHEET = [
  HEADER,
  '"28/10/2026 10:00:00","Pago válido","573001234567","Ana","60.000","Nequi","Ana","28/10/2026 09:58","Bebidas - aporte","1111100","u"',
  '"28/10/2026 11:00:00","Pago válido","573009998888","Luis","10.000","Nequi","Luis","28/10/2026 10:58","Bebidas - aporte","2222200","u"',
  '"28/10/2026 12:00:00","Pago válido","573007776666","Eva","5.000","Nequi","Eva","28/10/2026 11:58","Bebidas - aporte","","u"',
].join('\n');

const calls = [];
const fetchImpl = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === 'docs.google.com') return text(SHEET);
  const auth = init.headers?.Authorization;
  calls.push({ path: u.pathname, auth });
  if (u.pathname.endsWith('/me')) return json({ id: '777', name: 'Usuario del sistema' });
  if (u.pathname.endsWith('/me/adaccounts')) return json({ data: [{ id: 'act_22222', name: 'Dos', currency: 'USD', timezone_name: 'America/Mexico_City', account_status: 1 }, { id: 'bad', name: 'x' }] });
  const m = u.pathname.match(/\/(act_\d+)(\/[a-z]+)?$/);
  if (m?.[1] === 'act_404040') return json({ error: { code: 100, message: `Unsupported get request ${auth}` } }, 400);
  if (m?.[2] === '/insights') {
    return json({ data: [{ date_start: '2026-10-28', ad_id: `${m[1].replace('act_', '')}00`, ad_name: m[1] === 'act_11111' ? 'CT01 video' : 'PZZ promo', campaign_id: 'c', campaign_name: 'Camp', adset_id: 's', adset_name: 'S', country: 'CO', spend: '20000', impressions: '1', clicks: '1', actions: [] }] });
  }
  if (m?.[2] === '/ads') return json({ data: [] });
  if (m?.[2] === '/activities') return json({ data: [] });
  return json({ name: `Cuenta ${m?.[1]}`, timezone_name: 'America/Bogota', currency: 'COP', account_status: 1 });
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ads-api-pf-'));
const PF = [
  { id: 'principal', name: 'Principal', accounts: [{ id: 'act_11111', name: 'Uno', currency: 'COP', timezone: 'America/Bogota' }] },
  { id: 'bm-dos', name: 'BM dos', accounts: [{ id: 'act_22222', name: 'Dos', currency: 'COP', timezone: 'America/Bogota' }] },
];
const ctx = (extra = {}) => {
  const dataDir = tmp();
  saveConfig(dataDir, { portfolios: PF, spendVatPct: 0 });
  return { dataDir, env: { AGENTAUTO_META_TOKEN: T1, AGENTAUTO_META_TOKEN__BM_DOS: T2 }, fetchImpl, now: () => Date.parse('2026-10-29T15:00:00Z'), ...extra };
};
const backupCount = (dataDir) => (fs.existsSync(path.join(dataDir, 'ads', 'backups')) ? fs.readdirSync(path.join(dataDir, 'ads', 'backups')).length : 0);

test('a legacy data dir (single adAccountId) is migrated to the principal portfolio by any command, once', async () => {
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'ads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'ads', 'config.json'), JSON.stringify({ adAccountId: 'act_555555', flowPrefix: 'Barf' }));
  const out = await runAdsCommand('config-get', {}, { dataDir, env: {}, fetchImpl });
  assert.equal(out.config.portfolios[0].id, 'principal');
  assert.equal(out.config.portfolios[0].accounts[0].id, 'act_555555');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'ads', 'config.json'), 'utf8')).portfolios, 'persisted');
  const backups = backupCount(dataDir);
  await runAdsCommand('config-get', {}, { dataDir, env: {}, fetchImpl });
  assert.equal(backupCount(dataDir), backups, 'second run writes nothing');
});

test('sync --accounts only queries the selected accounts, each with its portfolio token', async () => {
  const c = ctx();
  calls.length = 0;
  const out = await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-29', accounts: 'act_22222' }, c);
  assert.deepEqual(out.accounts.map((a) => a.accountId), ['act_22222']);
  assert.ok(calls.length > 0 && calls.every((x) => x.path.includes('act_22222') && x.auth === `Bearer ${T2}`));
  const all = await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-29', accounts: 'all' }, c);
  assert.deepEqual(all.accounts.map((a) => a.accountId), ['act_11111', 'act_22222']);
});

test('--accounts is validated strictly', async () => {
  const c = ctx();
  for (const bad of ['act_99999', 'act_11111;rm', '11111', 'act_1,act_2']) {
    await assert.rejects(runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-29', accounts: bad }, c), AdsError, bad);
    await assert.rejects(runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', accounts: bad }, c), AdsError, bad);
  }
});

test('report and vouchers filter by account and by ad-name prefix', async () => {
  const c = ctx();
  await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-29' }, c);
  const all = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ad' }, c);
  assert.equal(all.kpis.gasto, 40000);
  assert.equal(all.kpis.valor, 75000);
  assert.deepEqual(all.accounts.map((a) => a.name).sort(), ['Dos', 'Sin cuenta', 'Uno']);

  const one = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ad', accounts: 'act_11111' }, c);
  assert.equal(one.kpis.gasto, 20000);
  assert.equal(one.kpis.valor, 60000);
  assert.ok(one.notes.length > 0);

  const named = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ad', name: ' pzz , ' }, c);
  assert.equal(named.kpis.gasto, 20000);
  assert.equal(named.kpis.valor, 10000);
  assert.deepEqual(named.nameFilter, ['pzz']);

  const v = await runAdsCommand('vouchers', { from: '2026-10-28', to: '2026-10-29', accounts: 'act_22222' }, c);
  assert.deepEqual(v.comprobantes.map((x) => x.adId), ["2222200"]);
  const vAll = await runAdsCommand('vouchers', { from: '2026-10-28', to: '2026-10-29' }, c);
  assert.equal(vAll.comprobantes.length, 3);

  await assert.rejects(runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', name: "x'; DROP TABLE ads;--" }, c), AdsError);
  await assert.rejects(runAdsCommand('vouchers', { from: '2026-10-28', to: '2026-10-29', name: '<b>' }, c), AdsError);
});

test('status lists presence per portfolio, never token values', async () => {
  const c = ctx({ env: { AGENTAUTO_META_TOKEN__BM_DOS: T2 } });
  const s = await runAdsCommand('status', {}, c);
  assert.equal(s.tokenPresent, true);
  assert.deepEqual(s.portfolios, [{ id: 'principal', tokenPresent: false }, { id: 'bm-dos', tokenPresent: true }]);
  assert.equal(JSON.stringify(s).includes(T2), false);
});

test('test-token checks the chosen portfolio and lists the accounts it can see', async () => {
  const c = ctx();
  calls.length = 0;
  const out = await runAdsCommand('test-token', { portfolio: 'bm-dos' }, c);
  assert.equal(out.name, 'Usuario del sistema');
  assert.deepEqual(out.accounts, [{ id: 'act_22222', name: 'Dos', currency: 'USD', timezone: 'America/Mexico_City', status: 1 }]);
  assert.ok(calls.every((x) => x.auth === `Bearer ${T2}`));
  await assert.rejects(runAdsCommand('test-token', { portfolio: 'bm-dos' }, ctx({ env: {} })), /token/i);
});

test('portfolio-add creates a slug (the first one is "principal") and rejects empty names', async () => {
  const dataDir = tmp();
  const c = { dataDir, env: {}, fetchImpl };
  const first = await runAdsCommand('portfolio-add', { name: 'Leasefy BM' }, c);
  assert.equal(first.portfolio.id, 'principal');
  const second = await runAdsCommand('portfolio-add', { name: 'Leasefy BM' }, c);
  assert.equal(second.portfolio.id, 'leasefy-bm');
  const third = await runAdsCommand('portfolio-add', { name: 'Leasefy BM' }, c);
  assert.equal(third.portfolio.id, 'leasefy-bm-2');
  await assert.rejects(runAdsCommand('portfolio-add', { name: '  ' }, c), AdsError);
  assert.equal(loadConfig(dataDir).portfolios.length, 3);
});

test('account-add validates against Meta first and stores name, currency and timezone', async () => {
  const c = ctx();
  const out = await runAdsCommand('account-add', { portfolio: 'bm-dos', account: '33333', name: '' }, c);
  assert.deepEqual(out.account, { id: 'act_33333', name: 'Cuenta act_33333', currency: 'COP', timezone: 'America/Bogota' });
  assert.equal(loadConfig(c.dataDir).portfolios[1].accounts.length, 2);
  const named = await runAdsCommand('account-add', { portfolio: 'principal', account: 'act_44444', name: ' Mi cuenta ' }, c);
  assert.equal(named.account.name, 'Mi cuenta');
});

test('account-add refuses unknown accounts, duplicates, bad ids and missing tokens without saving anything', async () => {
  const c = ctx();
  const before = JSON.stringify(loadConfig(c.dataDir).portfolios);
  await assert.rejects(runAdsCommand('account-add', { portfolio: 'principal', account: 'act_404040' }, c), /No encuentro esa cuenta/);
  await assert.rejects(runAdsCommand('account-add', { portfolio: 'principal', account: 'act_22222' }, c), /ya está/);
  await assert.rejects(runAdsCommand('account-add', { portfolio: 'principal', account: 'abc' }, c), /act_/);
  await assert.rejects(runAdsCommand('account-add', { portfolio: 'nope', account: 'act_55555' }, c), /portafolio/);
  await assert.rejects(runAdsCommand('account-add', { portfolio: 'bm-dos', account: 'act_55555' }, { ...c, env: {} }), /token/i);
  assert.equal(JSON.stringify(loadConfig(c.dataDir).portfolios), before);
  let message = '';
  try {
    await runAdsCommand('account-add', { portfolio: 'principal', account: 'act_404040' }, c);
  } catch (e) {
    message = e.message;
  }
  assert.equal(message.includes(T1), false);
});

test('removing an account or portfolio through config-set keeps the stored history rows', async () => {
  const c = ctx();
  await runAdsCommand('sync', { from: '2026-10-28', to: '2026-10-29' }, c);
  await runAdsCommand('config-set', { portfolios: [PF[0]] }, c);
  const report = await runAdsCommand('report', { from: '2026-10-28', to: '2026-10-29', group: 'ad' }, c);
  assert.equal(report.kpis.gasto, 20000, 'a removed account no longer counts under Todas');
  assert.equal((await runAdsCommand('status', {}, c)).counts.insights, 2, 'but its history is still in the database');
});
