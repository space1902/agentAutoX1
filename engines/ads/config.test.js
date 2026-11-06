import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig } from './config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ads-config-'));

test('defaults describe the X1 Pro Max account and the Looker thresholds', () => {
  assert.equal(DEFAULT_CONFIG.adAccountId, 'act_1962423981398837');
  assert.equal(DEFAULT_CONFIG.graphVersion, 'v26.0');
  assert.equal(DEFAULT_CONFIG.campaignPrefix, 'all');
  assert.equal(DEFAULT_CONFIG.sheetTab, 'Comprobantes');
  assert.equal(DEFAULT_CONFIG.validResult, 'Pago válido');
  assert.equal(DEFAULT_CONFIG.flowPrefix, 'Bebidas');
  assert.deepEqual(DEFAULT_CONFIG.thresholds, { minSpend: 15000, duplicateRoas: 3, duplicateSales: 3, scaleRoas: 2, keepRoas: 1.3, watchRoas: 1 });
  assert.equal(DEFAULT_CONFIG.lifecycle.testDays, 5);
  assert.equal(DEFAULT_CONFIG.lifecycle.testNotifyDay, 4);
  assert.equal(DEFAULT_CONFIG.lifecycle.testNotifyAt, '20:00');
  assert.equal(DEFAULT_CONFIG.lifecycle.postBudgetDays, 3);
  assert.equal(DEFAULT_CONFIG.lifecycle.postBudgetNotifyDay, 2);
});

test('mergeConfig overlays valid partial values and keeps the rest', () => {
  const cfg = mergeConfig({ flowPrefix: 'Barf', thresholds: { scaleRoas: 2.5 }, autoRefreshMinutes: 30 });
  assert.equal(cfg.flowPrefix, 'Barf');
  assert.equal(cfg.thresholds.scaleRoas, 2.5);
  assert.equal(cfg.thresholds.minSpend, 15000);
  assert.equal(cfg.autoRefreshMinutes, 30);
});

test('mergeConfig trims text and accepts a bare account number', () => {
  assert.equal(mergeConfig({ adAccountId: ' 1962423981398837 ' }).adAccountId, 'act_1962423981398837');
  assert.equal(mergeConfig({ campaignPrefix: ' ct ' }).campaignPrefix, 'ct');
});

test('mergeConfig rejects values that would break requests', () => {
  assert.throws(() => mergeConfig({ adAccountId: 'abc' }), /cuenta/i);
  assert.throws(() => mergeConfig({ graphVersion: '26' }), /versión/i);
  assert.throws(() => mergeConfig({ sheetId: 'a b/c' }), /hoja/i);
  assert.throws(() => mergeConfig({ thresholds: { keepRoas: -1 } }), /umbral/i);
  assert.throws(() => mergeConfig({ thresholds: { keepRoas: 'x' } }), /umbral/i);
  assert.throws(() => mergeConfig({ autoRefreshMinutes: -5 }), /minutos/i);
});

test('spendVatPct defaults to 19, is editable and stays apart from the per-country taxPct', () => {
  assert.equal(DEFAULT_CONFIG.spendVatPct, 19);
  const c = mergeConfig({ spendVatPct: '0' });
  assert.equal(c.spendVatPct, 0);
  assert.equal(c.countries.CO.taxPct, 0);
  assert.equal(mergeConfig({ countries: { CO: { taxPct: 5 } } }).spendVatPct, 19);
  assert.throws(() => mergeConfig({ spendVatPct: -1 }), /IVA/);
  assert.throws(() => mergeConfig({ spendVatPct: 101 }), /IVA/);
  assert.throws(() => mergeConfig({ spendVatPct: '' }), /IVA/);
});

test('mergeConfig refuses secrets', () => {
  assert.throws(() => mergeConfig({ token: 'abc' }), /token/i);
  assert.throws(() => mergeConfig({ accessToken: 'abc' }), /token/i);
});

test('mergeConfig ignores unknown keys', () => {
  assert.equal('whatever' in mergeConfig({ whatever: 1 }), false);
});

test('loadConfig returns defaults when the file is missing or broken', () => {
  const dir = tmp();
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  fs.mkdirSync(path.join(dir, 'ads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ads', 'config.json'), '{not json');
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test('saveConfig writes atomically, keeps a timestamped backup and never stores a token', () => {
  const dir = tmp();
  const first = saveConfig(dir, { flowPrefix: 'Uno' });
  assert.equal(first.flowPrefix, 'Uno');
  const file = path.join(dir, 'ads', 'config.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).flowPrefix, 'Uno');

  saveConfig(dir, { flowPrefix: 'Dos' }, { now: () => new Date('2026-10-29T12:00:00Z') });
  assert.equal(loadConfig(dir).flowPrefix, 'Dos');
  const backups = fs.readdirSync(path.join(dir, 'ads', 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^config-2026-10-29T12-00-00/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ads', 'backups', backups[0]), 'utf8')).flowPrefix, 'Uno');
  assert.equal(fs.readdirSync(path.join(dir, 'ads')).some((f) => f.endsWith('.tmp')), false);
  assert.equal(/token/i.test(fs.readFileSync(file, 'utf8')), false);
});

test('saveConfig keeps at most 10 backups', () => {
  const dir = tmp();
  for (let i = 0; i < 14; i++) saveConfig(dir, { flowPrefix: `F${i}` }, { now: () => new Date(Date.UTC(2026, 9, 1, 0, 0, i)) });
  assert.equal(fs.readdirSync(path.join(dir, 'ads', 'backups')).length, 10);
});

test('historyFrom accepts a date or empty and rejects anything else', () => {
  assert.equal(DEFAULT_CONFIG.historyFrom, '');
  assert.equal(mergeConfig({ historyFrom: '2026-10-01' }).historyFrom, '2026-10-01');
  assert.equal(mergeConfig({ historyFrom: '' }).historyFrom, '');
  assert.throws(() => mergeConfig({ historyFrom: '01/10/2026' }), /Historial/);
  assert.throws(() => mergeConfig({ historyFrom: '2026-13-40' }), /Historial/);
});

test('per-country settings merge, validate and allow new countries', () => {
  assert.equal(DEFAULT_CONFIG.countries.CO.rateToCop, 1);
  assert.equal(DEFAULT_CONFIG.countries.MX.currency, 'MXN');
  const c = mergeConfig({ countries: { MX: { rateToCop: 215, feePct: 3.5, costPerSale: 1200, taxPct: 16 }, PE: { currency: 'pen', rateToCop: 1100 } } });
  assert.deepEqual(c.countries.MX, { currency: 'MXN', rateToCop: 215, autoRate: true, feePct: 3.5, costPerSale: 1200, taxPct: 16 });
  assert.equal(c.countries.PE.currency, 'PEN');
  assert.equal(c.countries.CO.rateToCop, 1, 'untouched countries keep their values');
  assert.throws(() => mergeConfig({ countries: { MX: { feePct: 120 } } }), /entre 0 y 100/);
  assert.throws(() => mergeConfig({ countries: { MX: { rateToCop: -1 } } }), /tasa/);
  assert.throws(() => mergeConfig({ countries: { mexico: {} } }), /2 letras/);
});

test('country words are configurable per country', () => {
  const c = mergeConfig({ countryWords: { PE: ['Peru', 'PE'] } });
  assert.deepEqual(c.countryWords.PE, ['peru', 'pe']);
  assert.ok(c.countryWords.CO.includes('col'));
  assert.throws(() => mergeConfig({ countryWords: { PERU: ['x'] } }), /2 letras/);
});

test('a config saved before campaigns stopped being CT-only keeps working: the old default "CT" becomes "all"', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'ads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ads', 'config.json'), JSON.stringify({ campaignPrefix: 'CT', flowPrefix: 'Barf' }));
  const legacy = loadConfig(dir);
  assert.equal(legacy.campaignPrefix, 'all');
  assert.equal(legacy.flowPrefix, 'Barf');
  // A prefix chosen after the change is respected.
  saveConfig(dir, { campaignPrefix: 'CT' });
  assert.equal(loadConfig(dir).campaignPrefix, 'CT');
});

test('autoRate defaults to on per country and can be turned off', () => {
  assert.equal(DEFAULT_CONFIG.countries.MX.autoRate, true);
  assert.equal(DEFAULT_CONFIG.countries.CO.autoRate, true);
  assert.equal(mergeConfig({ countries: { PE: { currency: 'PEN' } } }).countries.PE.autoRate, true);
  const off = mergeConfig({ countries: { MX: { autoRate: false } } });
  assert.equal(off.countries.MX.autoRate, false);
  assert.equal(off.countries.MX.rateToCop, 0, 'the manual rate is untouched');
  assert.equal(mergeConfig({ countries: { MX: { rateToCop: 200 } } }).countries.MX.autoRate, true);
});

// ---- portfolios and ad accounts

const PF = () => [
  { id: 'principal', name: 'Portafolio principal', accounts: [{ id: 'act_1962423981398837', name: 'X1 Pro Max', currency: 'COP', timezone: 'America/Bogota' }] },
  { id: 'bm-dos', name: 'BM dos', accounts: [{ id: '2222222222', name: '', currency: 'usd' }] },
];

test('portfolios are validated, normalized and exposed with the legacy adAccountId of the principal portfolio', () => {
  assert.deepEqual(DEFAULT_CONFIG.portfolios, []);
  const c = mergeConfig({ portfolios: PF() });
  assert.equal(c.portfolios.length, 2);
  assert.equal(c.portfolios[1].accounts[0].id, 'act_2222222222', 'a bare number becomes act_<number>');
  assert.equal(c.portfolios[1].accounts[0].currency, 'USD');
  assert.equal(c.portfolios[1].accounts[0].name, 'act_2222222222', 'blank name falls back to the id');
  assert.equal(c.adAccountId, 'act_1962423981398837');
});

test('portfolio ids must be slugs and unique; account ids unique across portfolios', () => {
  assert.throws(() => mergeConfig({ portfolios: [{ id: 'Bad Slug', name: 'x', accounts: [] }] }), /identificador/i);
  assert.throws(() => mergeConfig({ portfolios: [{ id: 'a', name: 'x', accounts: [] }, { id: 'a', name: 'y', accounts: [] }] }), /repetido|duplicado/i);
  assert.throws(() => mergeConfig({ portfolios: [{ id: 'a', name: '', accounts: [] }] }), /nombre/i);
  assert.throws(() => mergeConfig({ portfolios: [{ id: 'a', name: 'x', accounts: [{ id: 'abc' }] }] }), /cuenta/i);
  assert.throws(
    () => mergeConfig({ portfolios: [{ id: 'a', name: 'x', accounts: [{ id: 'act_12345' }] }, { id: 'b', name: 'y', accounts: [{ id: 'act_12345' }] }] }),
    /otro portafolio|repetida/i,
  );
  assert.throws(() => mergeConfig({ portfolios: 'x' }), /portafolios/i);
});

test('nested keys that look like secrets are refused and unknown nested keys are dropped', () => {
  assert.throws(() => mergeConfig({ portfolios: [{ id: 'a', name: 'x', accounts: [], accessToken: 'zzz' }] }), /token/i);
  assert.throws(() => mergeConfig({ portfolios: [{ id: 'a', name: 'x', accounts: [{ id: 'act_12345', secret: 'q' }] }] }), /token/i);
  const c = mergeConfig({ portfolios: [{ id: 'a', name: 'x', extra: 1, accounts: [{ id: 'act_12345', foo: 1 }] }] });
  assert.equal('extra' in c.portfolios[0], false);
  assert.equal('foo' in c.portfolios[0].accounts[0], false);
});

test('a legacy config with adAccountId and no portfolios migrates to the principal portfolio (idempotent)', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'ads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ads', 'config.json'), JSON.stringify({ adAccountId: 'act_555555', flowPrefix: 'Barf' }));
  const first = loadConfig(dir);
  assert.deepEqual(first.portfolios, [{ id: 'principal', name: 'Portafolio principal', accounts: [{ id: 'act_555555', name: 'act_555555', currency: '', timezone: '' }] }]);
  assert.equal(first.adAccountId, 'act_555555');
  assert.equal(first.flowPrefix, 'Barf');
  const saved = saveConfig(dir, { flowPrefix: 'Barf2' });
  assert.deepEqual(saved.portfolios, first.portfolios);
  assert.deepEqual(loadConfig(dir).portfolios, first.portfolios, 'persisted on first save, same result on reload');
  assert.deepEqual(saveConfig(dir, {}).portfolios, first.portfolios);
});

test('the migrated account takes its name, currency and timezone from the stored account info', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'ads'), { recursive: true });
  const { createStore } = await import('./store.js');
  const store = createStore(path.join(dir, 'ads', 'ads.db'));
  store.setKv('account', { name: 'X1 Pro Max', timezone: 'America/Bogota', currency: 'COP' });
  store.close();
  const c = loadConfig(dir);
  assert.deepEqual(c.portfolios[0].accounts[0], { id: 'act_1962423981398837', name: 'X1 Pro Max', currency: 'COP', timezone: 'America/Bogota' });
});

test('a fresh data dir has no portfolios (first-run), and an explicit empty list is respected', () => {
  const dir = tmp();
  assert.deepEqual(loadConfig(dir).portfolios, []);
  saveConfig(dir, { flowPrefix: 'Uno' });
  assert.deepEqual(loadConfig(dir).portfolios, []);
});

test('saving portfolios replaces the list and keeps adAccountId in step', () => {
  const dir = tmp();
  const c = saveConfig(dir, { portfolios: PF() });
  assert.equal(loadConfig(dir).portfolios[1].id, 'bm-dos');
  assert.equal(c.adAccountId, 'act_1962423981398837');
  const only = saveConfig(dir, { portfolios: [PF()[1]] });
  assert.equal(only.adAccountId, 'act_2222222222', 'first account of the first portfolio when there is no principal');
  assert.equal(/token/i.test(fs.readFileSync(path.join(dir, 'ads', 'config.json'), 'utf8')), false);
});
