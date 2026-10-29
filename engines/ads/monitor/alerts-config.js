// Settings of the in-app alerts monitor (<data dir>/ads/alerts-config.json). Same shape as the standalone monitor's
// config.json plus a few app options. Phone numbers are not secrets; the Meta token and the WhatsApp session never
// live here.
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG as MONITOR_DEFAULTS, applyThresholds, mergeConfig as mergeMonitor } from './config.js';

export class AlertsConfigError extends Error {}

export const ALERTS_DEFAULTS = mergeMonitor({
  mode: 'alert_only',
  // Where "a sale" comes from: valid payments of the sheet (real), Meta purchases, or whichever is higher.
  salesSource: 'sheet',
  // false = alerts only. true = pause/budget requests are offered and executed only after the user replies SI.
  allowActions: false,
  summaryEnabled: true,
  whatsapp: { senderPhone: '', alertTo: '' },
});

const SOURCES = ['sheet', 'meta', 'both'];
const SECRET_KEYS = /token|secret|password|apikey/i;

const int = (value, label, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new AlertsConfigError(`${label} debe estar entre ${min} y ${max}.`);
  return Math.round(n);
};

const hours = (value, label) => {
  const start = Number(value?.start);
  const end = Number(value?.end);
  if (![start, end].every((h) => Number.isInteger(h) && h >= 0 && h <= 24)) throw new AlertsConfigError(`Las horas de «${label}» deben ser enteros entre 0 y 24.`);
  return { start, end };
};

export function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('3')) digits = `57${digits}`;
  if (digits.length < 8 || digits.length > 15) throw new AlertsConfigError('El número debe incluir el código de país y tener entre 8 y 15 dígitos.');
  return digits;
}

function rejectSecrets(object, path = '') {
  for (const [key, value] of Object.entries(object ?? {})) {
    if (SECRET_KEYS.test(key)) throw new AlertsConfigError('Los tokens y secretos no se guardan en la configuración.');
    if (value && typeof value === 'object' && !Array.isArray(value)) rejectSecrets(value, `${path}${key}.`);
  }
}

export function mergeAlertsConfig(partial = {}, base = ALERTS_DEFAULTS) {
  const p = partial ?? {};
  rejectSecrets(p);
  const out = structuredClone(base);

  if (p.pollMinutes !== undefined) out.pollMinutes = int(p.pollMinutes, 'Los minutos entre sondeos', 1, 120);
  if (p.baselineDays !== undefined) out.baselineDays = int(p.baselineDays, 'Los días de referencia', 1, 30);
  if (p.cooldownMin !== undefined) out.cooldownMin = int(p.cooldownMin, 'Los minutos de espera entre avisos', 1, 1440);
  if (p.recommendEveryDays !== undefined) out.recommendEveryDays = int(p.recommendEveryDays, 'Los días entre recomendaciones', 1, 60);
  if (p.requestTtlMin !== undefined) out.requestTtlMin = int(p.requestTtlMin, 'Los minutos de vigencia de una solicitud', 1, 1440);
  if (p.budgetChangeMaxPct !== undefined) out.budgetChangeMaxPct = int(p.budgetChangeMaxPct, 'El tope de cambio de presupuesto (%)', 1, 100);
  if (p.campaignPrefix !== undefined) out.campaignPrefix = String(p.campaignPrefix).trim().slice(0, 40);
  if (p.activeHours !== undefined) out.activeHours = hours(p.activeHours, 'horas activas');
  if (p.restrictedHours !== undefined) out.restrictedHours = hours(p.restrictedHours, 'horas restringidas');
  if (p.salesSource !== undefined) {
    if (!SOURCES.includes(p.salesSource)) throw new AlertsConfigError('La fuente de ventas debe ser sheet, meta o both.');
    out.salesSource = p.salesSource;
  }
  for (const key of ['allowActions', 'summaryEnabled', 'killSwitch']) if (p[key] !== undefined) out[key] = Boolean(p[key]);

  if (p.thresholds !== undefined) {
    const changes = {};
    for (const key of Object.keys(MONITOR_DEFAULTS.thresholds)) if (p.thresholds?.[key] !== undefined) changes[key] = Number(p.thresholds[key]);
    const result = applyThresholds(out, changes);
    if (result.error) {
      const text = {
        unknown: 'Umbral desconocido.',
        not_positive: 'Cada umbral debe ser un número mayor que cero.',
        target_review: 'El CPA objetivo debe ser menor que el CPA de revisión.',
        worry_action: 'Los minutos de preocupación deben ser menores que los minutos de acción.',
      }[result.code];
      throw new AlertsConfigError(text ?? result.error);
    }
    out.thresholds = result.config.thresholds;
  }

  if (p.whatsapp !== undefined) {
    if (p.whatsapp.senderPhone !== undefined) out.whatsapp.senderPhone = normalizePhone(p.whatsapp.senderPhone);
    if (p.whatsapp.alertTo !== undefined) out.whatsapp.alertTo = normalizePhone(p.whatsapp.alertTo);
  }
  out.mode = 'alert_only';
  return out;
}

export const alertsConfigPath = (dataDir) => path.join(dataDir, 'ads', 'alerts-config.json');

export function loadAlertsConfig(dataDir) {
  try {
    return mergeAlertsConfig(JSON.parse(fs.readFileSync(alertsConfigPath(dataDir), 'utf8').replace(/^﻿/, '')));
  } catch {
    return mergeAlertsConfig({});
  }
}

export function saveAlertsConfig(dataDir, partial, { now = () => new Date() } = {}) {
  const next = mergeAlertsConfig(partial, loadAlertsConfig(dataDir));
  const file = alertsConfigPath(dataDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.copyFileSync(file, path.join(backups, `alerts-config-${now().toISOString().replace(/[:.]/g, '-')}.json`));
    const old = fs.readdirSync(backups).filter((f) => f.startsWith('alerts-config-')).sort();
    for (const name of old.slice(0, Math.max(0, old.length - 10))) fs.rmSync(path.join(backups, name), { force: true });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}
