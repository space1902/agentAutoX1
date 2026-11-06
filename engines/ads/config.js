// Ads config (<data dir>/ads/config.json). Never holds secrets: the Meta token only travels in the
// AGENTAUTO_META_TOKEN environment variable.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_COUNTRY_TOKENS } from './country.js';
import { ACCOUNT_RE, PRINCIPAL_ID, SLUG_RE } from './portfolios.js';

export const DEFAULT_CONFIG = Object.freeze({
  // Legacy single account. With portfolios it only mirrors the principal portfolio's first account (the alerts monitor and
  // older readers use it); the default is what a pre-portfolio data dir was syncing.
  adAccountId: 'act_1962423981398837',
  // Meta Business Managers and their ad accounts: [{ id: slug, name, accounts: [{ id: 'act_...', name, currency, timezone }] }].
  // Tokens are never here: each portfolio's token lives in the OS keyring (see portfolios.js).
  portfolios: Object.freeze([]),
  graphVersion: 'v26.0',
  // "all" (or empty) monitors every campaign. Version 2 of the scope: before it the default was "CT" (CT campaigns only).
  campaignPrefix: 'all',
  prefixVersion: 2,
  sheetId: '1DnfAORSuDSbfgxCffJ7fkdBexcVrLSHT8gQqQkh8urw',
  sheetTab: 'Comprobantes',
  validResult: 'Pago válido',
  flowPrefix: 'Bebidas',
  currency: 'COP',
  // IVA (%) Meta charges on top of the ad spend. The API returns spend WITHOUT it, so every spend shown or used in
  // a decision is multiplied by (1 + spendVatPct / 100). Not the per-country taxPct (tax on the value of the sales).
  spendVatPct: 19,
  // First day to keep in the history ('' = detect the earliest day found in the sheet or in Meta).
  historyFrom: '',
  // Countries shown in the views (default: only Colombia). Data of the others is left out, or grouped as
  // "Otros países" when includeOtherCountries is on.
  enabledCountries: Object.freeze(['CO']),
  includeOtherCountries: false,
  // Words in a campaign name that tag its country.
  countryWords: Object.freeze(Object.fromEntries(Object.entries(DEFAULT_COUNTRY_TOKENS).map(([k, v]) => [k, Object.freeze([...v])]))),
  // Per country: currency of the sheet's Valor, exchange rate to COP (0 = not set yet; with autoRate on it is only the
  // fallback/override for the live rate saved in fx_rates), payment fee % of the value,
  // product/other cost per sale (COP) and tax % of the value. Spend is already in the account currency (COP).
  countries: Object.freeze({
    CO: Object.freeze({ currency: 'COP', rateToCop: 1, autoRate: true, feePct: 0, costPerSale: 0, taxPct: 0 }),
    MX: Object.freeze({ currency: 'MXN', rateToCop: 0, autoRate: true, feePct: 0, costPerSale: 0, taxPct: 0 }),
    VE: Object.freeze({ currency: 'USD', rateToCop: 0, autoRate: true, feePct: 0, costPerSale: 0, taxPct: 0 }),
  }),
  // Minutes between automatic refreshes of today while the section is open (0 = off).
  autoRefreshMinutes: 15,
  // Suggested action rules (ported from the Looker report).
  thresholds: Object.freeze({ minSpend: 15000, duplicateRoas: 3, duplicateSales: 3, scaleRoas: 2, keepRoas: 1.3, watchRoas: 1 }),
  // Placeholders for the notification phases (not used yet).
  lifecycle: Object.freeze({
    testDays: 5,
    testNotifyDay: 4,
    testNotifyAt: '20:00',
    postBudgetDays: 3,
    postBudgetNotifyDay: 2,
    postBudgetNotifyAt: '20:00',
    // Phase B (daily decisions).
    testEnabled: true,
    budgetEnabled: true,
    // Days before the budget change used as the comparison baseline.
    windowDays: 3,
    minRoasToScale: 2,
    maxCpaWorsenPct: 25,
    minSales: 2,
    lowerCpaWorsenPct: 50,
    // Suggested next increase (capped by maxRaisePct, the monitor's budgetChangeMaxPct).
    raisePct: 20,
    maxRaisePct: 20,
    // A decision missed because the app was closed is still issued up to this many days late.
    lateDays: 2,
    notifyDesktop: true,
    notifyWhatsapp: false,
    snapshotMinutes: 30,
  }),
});

const SECRET_KEYS = /token|secret|password|apikey/i;
const MAX_BACKUPS = 10;

export class ConfigError extends Error {}

const text = (value, label, { pattern, max = 200, allowEmpty = false } = {}) => {
  const s = String(value ?? '').trim();
  if (!s && !allowEmpty) throw new ConfigError(`${label} no puede estar vacío.`);
  if (s.length > max || (pattern && s && !pattern.test(s))) throw new ConfigError(`${label} no es válido.`);
  return s;
};

const nonNegative = (value, label) => {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`El umbral «${label}» debe ser un número mayor o igual a 0.`);
  return n;
};

const hhmm = (value, label) => text(value, label, { pattern: /^([01]\d|2[0-3]):[0-5]\d$/ });
const wholeDays = (value, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 60) throw new ConfigError(`${label} debe ser un número entero de días.`);
  return n;
};

const MAX_PORTFOLIOS = 20;
const MAX_ACCOUNTS = 50;

const accountId = (value) => {
  const raw = text(value, 'La cuenta publicitaria');
  const id = /^\d+$/.test(raw) ? `act_${raw}` : raw;
  if (!ACCOUNT_RE.test(id)) throw new ConfigError('La cuenta publicitaria debe verse como act_1234567890.');
  return id;
};

const assertNoSecretKeys = (obj) => {
  for (const key of Object.keys(obj ?? {})) {
    if (SECRET_KEYS.test(key)) throw new ConfigError('El token de Meta no se guarda en la configuración.');
  }
};

// Validated copy of the portfolio list (unknown keys dropped, ids normalized, uniqueness enforced).
export function normalizePortfolios(list) {
  if (!Array.isArray(list) || list.length > MAX_PORTFOLIOS) throw new ConfigError('Los portafolios deben ser una lista (máximo 20).');
  const seenPortfolios = new Set();
  const owner = new Map();
  return list.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new ConfigError('Cada portafolio debe tener identificador, nombre y cuentas.');
    assertNoSecretKeys(raw);
    const id = String(raw.id ?? '').trim();
    if (!SLUG_RE.test(id)) throw new ConfigError('El identificador del portafolio no es válido (minúsculas, números y guiones, hasta 40).');
    if (seenPortfolios.has(id)) throw new ConfigError(`El portafolio «${id}» está repetido.`);
    seenPortfolios.add(id);
    const name = text(raw.name, 'El nombre del portafolio', { max: 80 });
    const accounts = raw.accounts ?? [];
    if (!Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS) throw new ConfigError('Las cuentas de un portafolio deben ser una lista (máximo 50).');
    const seenHere = new Set();
    return {
      id,
      name,
      accounts: accounts.map((a) => {
        assertNoSecretKeys(a);
        const aid = accountId(a?.id);
        if (seenHere.has(aid)) throw new ConfigError(`La cuenta ${aid} está repetida en el portafolio.`);
        if (owner.has(aid) && owner.get(aid) !== id) throw new ConfigError(`La cuenta ${aid} ya está en otro portafolio.`);
        seenHere.add(aid);
        owner.set(aid, id);
        return {
          id: aid,
          name: text(a.name, 'El nombre de la cuenta', { allowEmpty: true, max: 100 }) || aid,
          currency: text(a.currency, 'La moneda de la cuenta', { allowEmpty: true, pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
          timezone: text(a.timezone, 'La zona horaria de la cuenta', { allowEmpty: true, max: 60, pattern: /^[A-Za-z0-9_+/-]+$/ }),
        };
      }),
    };
  });
}

// Account the single-account readers (alerts monitor, old callers) use: the principal portfolio's first account, else the first one.
export function primaryAccountId(portfolios) {
  const withAccounts = (portfolios ?? []).filter((p) => p.accounts?.length);
  return (withAccounts.find((p) => p.id === PRINCIPAL_ID) ?? withAccounts[0])?.accounts[0].id ?? null;
}

// Defaults + validated overrides. Unknown keys are dropped; anything that looks like a secret is refused.
export function mergeConfig(partial = {}, base = DEFAULT_CONFIG) {
  const p = partial ?? {};
  for (const key of Object.keys(p)) {
    if (SECRET_KEYS.test(key)) throw new ConfigError('El token de Meta no se guarda en la configuración.');
  }
  const out = { ...base, portfolios: structuredClone(base.portfolios ?? []), thresholds: { ...base.thresholds }, lifecycle: { ...base.lifecycle }, countries: structuredClone(base.countries), enabledCountries: [...base.enabledCountries], countryWords: structuredClone(base.countryWords) };

  if (p.adAccountId !== undefined) out.adAccountId = accountId(p.adAccountId);
  if (p.portfolios !== undefined) out.portfolios = normalizePortfolios(p.portfolios);
  // With portfolios, the legacy field follows the principal one.
  out.adAccountId = primaryAccountId(out.portfolios) ?? out.adAccountId;
  if (p.graphVersion !== undefined) out.graphVersion = text(p.graphVersion, 'La versión de Graph', { pattern: /^v\d+\.\d+$/ });
  if (p.campaignPrefix !== undefined) out.campaignPrefix = text(p.campaignPrefix, 'El prefijo de campañas', { allowEmpty: true, max: 40 });
  if (p.sheetId !== undefined) out.sheetId = text(p.sheetId, 'El ID de la hoja', { pattern: /^[A-Za-z0-9_-]{10,100}$/ });
  if (p.sheetTab !== undefined) out.sheetTab = text(p.sheetTab, 'La pestaña de la hoja', { max: 100 });
  if (p.validResult !== undefined) out.validResult = text(p.validResult, 'El resultado válido', { max: 100 });
  if (p.flowPrefix !== undefined) out.flowPrefix = text(p.flowPrefix, 'El prefijo de flujo', { allowEmpty: true, max: 100 });
  if (p.currency !== undefined) out.currency = text(p.currency, 'La moneda', { pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
  if (p.spendVatPct !== undefined) {
    const n = typeof p.spendVatPct === 'string' && p.spendVatPct.trim() === '' ? NaN : Number(p.spendVatPct);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new ConfigError('El IVA sobre el gasto en Meta (%) debe estar entre 0 y 100.');
    out.spendVatPct = n;
  }
  if (p.enabledCountries !== undefined) {
    const list = Array.isArray(p.enabledCountries) ? [...new Set(p.enabledCountries.map((c) => String(c).trim().toUpperCase()))] : null;
    if (!list || list.length === 0 || list.length > 40 || list.some((c) => !/^[A-Z]{2}$/.test(c))) {
      throw new ConfigError('Elige al menos un país habilitado (códigos de 2 letras como CO o MX).');
    }
    out.enabledCountries = list;
  }
  if (p.includeOtherCountries !== undefined) out.includeOtherCountries = Boolean(p.includeOtherCountries);
  if (p.historyFrom !== undefined) {
    const v = String(p.historyFrom ?? '').trim();
    if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new ConfigError('«Historial desde» debe ser una fecha AAAA-MM-DD o quedar vacío.');
    out.historyFrom = v;
  }
  for (const [code, c] of Object.entries(p.countries ?? {})) {
    if (!/^[A-Z]{2}$/.test(code)) throw new ConfigError(`El país «${code}» debe tener un código de 2 letras (CO, MX...).`);
    const prev = out.countries[code] ?? { currency: 'COP', rateToCop: 0, autoRate: true, feePct: 0, costPerSale: 0, taxPct: 0 };
    const pct = (v, label) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ConfigError(`${label} de ${code} debe estar entre 0 y 100.`);
      return n;
    };
    out.countries[code] = {
      currency: c.currency === undefined ? prev.currency : text(c.currency, `La moneda de ${code}`, { pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
      rateToCop: c.rateToCop === undefined ? prev.rateToCop : nonNegative(c.rateToCop, `tasa a COP de ${code}`),
      autoRate: c.autoRate === undefined ? prev.autoRate !== false : Boolean(c.autoRate),
      feePct: c.feePct === undefined ? prev.feePct : pct(c.feePct, 'La comisión (%)'),
      costPerSale: c.costPerSale === undefined ? prev.costPerSale : nonNegative(c.costPerSale, `costo por venta de ${code}`),
      taxPct: c.taxPct === undefined ? prev.taxPct : pct(c.taxPct, 'El impuesto (%)'),
    };
  }
  for (const [code, list] of Object.entries(p.countryWords ?? {})) {
    if (!/^[A-Z]{2}$/.test(code) || !Array.isArray(list) || list.length > 12) throw new ConfigError('Las palabras de país deben ser una lista por código de 2 letras.');
    out.countryWords[code] = list.map((w) => text(w, 'La palabra de país', { max: 24 }).toLowerCase());
  }
  if (p.autoRefreshMinutes !== undefined) {
    const n = Number(p.autoRefreshMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw new ConfigError('Los minutos de actualización automática deben estar entre 0 y 1440.');
    out.autoRefreshMinutes = Math.round(n);
  }
  for (const key of Object.keys(base.thresholds)) {
    if (p.thresholds?.[key] !== undefined) out.thresholds[key] = nonNegative(p.thresholds[key], key);
  }
  const life = p.lifecycle ?? {};
  for (const key of ['testDays', 'testNotifyDay', 'postBudgetDays', 'postBudgetNotifyDay']) {
    if (life[key] !== undefined) out.lifecycle[key] = wholeDays(life[key], key);
  }
  for (const key of ['testEnabled', 'budgetEnabled', 'notifyDesktop', 'notifyWhatsapp']) {
    if (life[key] !== undefined) out.lifecycle[key] = Boolean(life[key]);
  }
  for (const key of ['windowDays', 'minRoasToScale', 'maxCpaWorsenPct', 'minSales', 'lowerCpaWorsenPct', 'raisePct', 'maxRaisePct', 'lateDays', 'snapshotMinutes']) {
    if (life[key] !== undefined) out.lifecycle[key] = nonNegative(life[key], key);
  }
  for (const key of ['testNotifyAt', 'postBudgetNotifyAt']) {
    if (life[key] !== undefined) out.lifecycle[key] = hhmm(life[key], key);
  }
  return out;
}

export const adsDir = (dataDir) => path.join(dataDir, 'ads');
export const configPath = (dataDir) => path.join(adsDir(dataDir), 'config.json');

const dbPath = (dataDir) => path.join(adsDir(dataDir), 'ads.db');

// Name/currency/timezone the old single-account sync stored in the database (read-only; any failure = nothing known).
function legacyAccountInfo(dataDir) {
  let db;
  try {
    db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = 'account'").get();
    const info = row ? JSON.parse(row.value) : null;
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to close */
    }
  }
}

// A pre-portfolio data dir (config without a `portfolios` key, or no config but a database) becomes one "principal"
// portfolio holding its single account. Same input -> same output, so running it again changes nothing.
function legacyPortfolios(dataDir, legacyId) {
  const info = legacyAccountInfo(dataDir) ?? {};
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return '';
    }
  };
  return normalizePortfolios([
    {
      id: PRINCIPAL_ID,
      name: 'Portafolio principal',
      accounts: [{
        id: legacyId,
        name: safe(() => text(info.name, 'nombre', { allowEmpty: true, max: 100 })),
        currency: safe(() => text(info.currency, 'moneda', { allowEmpty: true, pattern: /^[A-Za-z]{3}$/ })),
        timezone: safe(() => text(info.timezone, 'zona', { allowEmpty: true, max: 60, pattern: /^[A-Za-z0-9_+/-]+$/ })),
      }],
    },
  ]);
}

export function loadConfig(dataDir) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8').replace(/^﻿/, ''));
  } catch {
    /* missing or broken file: defaults */
  }
  try {
    const cfg = mergeConfig(parsed ?? {});
    // The old default only showed CT campaigns; it is not a choice the user made, so it widens to every campaign once.
    if (parsed && parsed.prefixVersion !== 2 && String(parsed.campaignPrefix ?? '').trim() === 'CT') cfg.campaignPrefix = 'all';
    if (!Array.isArray(parsed?.portfolios) && (parsed || fs.existsSync(dbPath(dataDir)))) {
      cfg.portfolios = legacyPortfolios(dataDir, cfg.adAccountId);
    }
    return cfg;
  } catch {
    return mergeConfig({});
  }
}

// Writes the migrated portfolios once (a no-op when the config already has them or there is nothing to migrate).
export function ensureMigrated(dataDir) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8').replace(/^﻿/, ''));
  } catch {
    /* no file */
  }
  if (Array.isArray(parsed?.portfolios)) return false;
  const cfg = loadConfig(dataDir);
  if (!cfg.portfolios.length) return false;
  saveConfig(dataDir, { portfolios: cfg.portfolios });
  return true;
}

// Windows can refuse a rename while another process has the target open for a moment (EPERM/EBUSY/EACCES).
function renameWithRetry(from, to, attempts = 40) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        fs.rmSync(from, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + i * 5);
    }
  }
}

// Atomic write (temp file + rename) after copying the previous file to ads/backups/config-<timestamp>.json.
export function saveConfig(dataDir, partial, { now = () => new Date() } = {}) {
  const next = mergeConfig(partial, loadConfig(dataDir));
  const dir = adsDir(dataDir);
  const file = configPath(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(backups, `config-${stamp}.json`));
    const old = fs.readdirSync(backups).filter((f) => f.startsWith('config-')).sort();
    for (const name of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) fs.rmSync(path.join(backups, name), { force: true });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameWithRetry(tmp, file);
  return next;
}
