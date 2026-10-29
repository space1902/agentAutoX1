// Runtime configuration (config.json). Thresholds are editable at runtime through WhatsApp.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const DEFAULT_CONFIG = Object.freeze({
  // alert_only: actions run only after a "SI <id>" reply. autonomous: reserved, behaves like alert_only.
  mode: 'alert_only',
  killSwitch: false,
  graphVersion: 'v26.0',
  campaignPrefix: 'CT',
  pollMinutes: 15,
  baselineDays: 5,
  recommendEveryDays: 3,
  cooldownMin: 60,
  requestTtlMin: 120,
  budgetChangeMaxPct: 20,
  // Hours are whole hours in the AD ACCOUNT timezone. [start, end) and may wrap midnight.
  activeHours: { start: 7, end: 23 },
  restrictedHours: { start: 23, end: 7 },
  thresholds: {
    targetCpa: 2500, // green up to this CPA (COP); also "worry" when an ad spends this much without a sale
    reviewCpa: 5000, // yellow up to this CPA; above is red; an ad spending this much without a sale asks to pause
    gapWorryMin: 45, // floor for "no sale in the whole account" (worry)
    gapActionMin: 60, // floor for "no sale in the whole account" (asks for an action)
    maxGapMin: 180, // cap for the adaptive widening
    noSpendHours: 2,
    noPurchaseHours: 3,
    minConversationsNoPurchase: 10,
    costPerConversationMult: 1.5,
    minConversationsForCost: 5,
    frequencyMax: 2.5,
    ctrMinRatio: 0.6,
    cpmMaxRatio: 1.4,
    minImpressions: 1000,
  },
});

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    out[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export const mergeConfig = (partial) => deepMerge(structuredClone(DEFAULT_CONFIG), partial ?? {});

export function loadConfig(path) {
  if (!existsSync(path)) return mergeConfig({});
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read config file ${path}: ${error.message}`);
  }
  return mergeConfig(parsed);
}

export function saveConfig(path, config) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

// Names accepted by the "valor" command (Spanish aliases, accents ignored) -> thresholds key.
const ALIASES = {
  objetivo: 'targetCpa', meta: 'targetCpa', verde: 'targetCpa',
  revisar: 'reviewCpa', riesgo: 'reviewCpa', rojo: 'reviewCpa',
  preocupacion: 'gapWorryMin', accion: 'gapActionMin',
  frecuencia: 'frequencyMax', costoconversacion: 'costPerConversationMult',
  ctr: 'ctrMinRatio', cpm: 'cpmMaxRatio',
  sinGasto: 'noSpendHours', sinventas3h: 'noPurchaseHours',
};
const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function resolveThresholdName(name) {
  const clean = strip(name ?? '');
  const alias = Object.entries(ALIASES).find(([k]) => strip(k) === clean);
  if (alias) return alias[1];
  return Object.keys(DEFAULT_CONFIG.thresholds).find((k) => strip(k) === clean) ?? null;
}

// Pure: sets several canonical threshold keys at once and validates the FINAL state, so changing
// target and review together never fails on an intermediate step. Returns { config } or { error, code }.
export function applyThresholds(config, changes) {
  const next = structuredClone(config);
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in DEFAULT_CONFIG.thresholds)) return { error: `unknown threshold "${key}"`, code: 'unknown' };
    if (!Number.isFinite(value) || value <= 0) return { error: 'value must be a positive number', code: 'not_positive' };
    next.thresholds[key] = value;
  }
  const t = next.thresholds;
  if (t.targetCpa >= t.reviewCpa) return { error: 'target CPA must be lower than review CPA', code: 'target_review' };
  if (t.gapWorryMin >= t.gapActionMin) return { error: 'worry gap must be lower than action gap', code: 'worry_action' };
  return { config: next };
}

// Same, for a single threshold given by any accepted name. Returns { config, key } or { error, code }.
export function applyThreshold(config, name, value) {
  const key = resolveThresholdName(name);
  if (!key) return { error: `unknown threshold "${name}"`, code: 'unknown' };
  const result = applyThresholds(config, { [key]: value });
  return result.error ? result : { config: result.config, key };
}
