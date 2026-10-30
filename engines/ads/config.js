// Ads config (<data dir>/ads/config.json). Never holds secrets: the Meta token only travels in the
// AGENTAUTO_META_TOKEN environment variable.
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_COUNTRY_TOKENS } from './country.js';

export const DEFAULT_CONFIG = Object.freeze({
  adAccountId: 'act_1962423981398837',
  graphVersion: 'v26.0',
  // "all" (or empty) monitors every campaign.
  campaignPrefix: 'CT',
  sheetId: '1DnfAORSuDSbfgxCffJ7fkdBexcVrLSHT8gQqQkh8urw',
  sheetTab: 'Comprobantes',
  validResult: 'Pago válido',
  flowPrefix: 'Bebidas',
  currency: 'COP',
  // First day to keep in the history ('' = detect the earliest day found in the sheet or in Meta).
  historyFrom: '',
  // Countries shown in the views (default: only Colombia). Data of the others is left out, or grouped as
  // "Otros países" when includeOtherCountries is on.
  enabledCountries: Object.freeze(['CO']),
  includeOtherCountries: false,
  // Words in a campaign name that tag its country.
  countryWords: Object.freeze(Object.fromEntries(Object.entries(DEFAULT_COUNTRY_TOKENS).map(([k, v]) => [k, Object.freeze([...v])]))),
  // Per country: currency of the sheet's Valor, exchange rate to COP (0 = not set yet), payment fee % of the value,
  // product/other cost per sale (COP) and tax % of the value. Spend is already in the account currency (COP).
  countries: Object.freeze({
    CO: Object.freeze({ currency: 'COP', rateToCop: 1, feePct: 0, costPerSale: 0, taxPct: 0 }),
    MX: Object.freeze({ currency: 'MXN', rateToCop: 0, feePct: 0, costPerSale: 0, taxPct: 0 }),
    VE: Object.freeze({ currency: 'USD', rateToCop: 0, feePct: 0, costPerSale: 0, taxPct: 0 }),
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

// Defaults + validated overrides. Unknown keys are dropped; anything that looks like a secret is refused.
export function mergeConfig(partial = {}, base = DEFAULT_CONFIG) {
  const p = partial ?? {};
  for (const key of Object.keys(p)) {
    if (SECRET_KEYS.test(key)) throw new ConfigError('El token de Meta no se guarda en la configuración.');
  }
  const out = { ...base, thresholds: { ...base.thresholds }, lifecycle: { ...base.lifecycle }, countries: structuredClone(base.countries), enabledCountries: [...base.enabledCountries], countryWords: structuredClone(base.countryWords) };

  if (p.adAccountId !== undefined) {
    const raw = text(p.adAccountId, 'La cuenta publicitaria');
    const id = /^\d+$/.test(raw) ? `act_${raw}` : raw;
    if (!/^act_\d{5,25}$/.test(id)) throw new ConfigError('La cuenta publicitaria debe verse como act_1234567890.');
    out.adAccountId = id;
  }
  if (p.graphVersion !== undefined) out.graphVersion = text(p.graphVersion, 'La versión de Graph', { pattern: /^v\d+\.\d+$/ });
  if (p.campaignPrefix !== undefined) out.campaignPrefix = text(p.campaignPrefix, 'El prefijo de campañas', { allowEmpty: true, max: 40 });
  if (p.sheetId !== undefined) out.sheetId = text(p.sheetId, 'El ID de la hoja', { pattern: /^[A-Za-z0-9_-]{10,100}$/ });
  if (p.sheetTab !== undefined) out.sheetTab = text(p.sheetTab, 'La pestaña de la hoja', { max: 100 });
  if (p.validResult !== undefined) out.validResult = text(p.validResult, 'El resultado válido', { max: 100 });
  if (p.flowPrefix !== undefined) out.flowPrefix = text(p.flowPrefix, 'El prefijo de flujo', { allowEmpty: true, max: 100 });
  if (p.currency !== undefined) out.currency = text(p.currency, 'La moneda', { pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
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
    const prev = out.countries[code] ?? { currency: 'COP', rateToCop: 0, feePct: 0, costPerSale: 0, taxPct: 0 };
    const pct = (v, label) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ConfigError(`${label} de ${code} debe estar entre 0 y 100.`);
      return n;
    };
    out.countries[code] = {
      currency: c.currency === undefined ? prev.currency : text(c.currency, `La moneda de ${code}`, { pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
      rateToCop: c.rateToCop === undefined ? prev.rateToCop : nonNegative(c.rateToCop, `tasa a COP de ${code}`),
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

export function loadConfig(dataDir) {
  try {
    const raw = fs.readFileSync(configPath(dataDir), 'utf8').replace(/^﻿/, '');
    return mergeConfig(JSON.parse(raw));
  } catch {
    return mergeConfig({});
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
  fs.renameSync(tmp, file);
  return next;
}
