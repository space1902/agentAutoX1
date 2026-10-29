// Command layer of the ads engine (used by ads-cli.js and the tests). The Meta token is read ONLY from the
// AGENTAUTO_META_TOKEN environment variable; it is never stored, logged or returned.
import { DEFAULT_CONFIG, ConfigError, adsDir, loadConfig, saveConfig } from './config.js';
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { fetchAccount } from './meta-data.js';
import { buildReport } from './report.js';
import { existsSync } from 'node:fs';
import { AlertsConfigError, ALERTS_DEFAULTS, loadAlertsConfig, saveAlertsConfig } from './monitor/alerts-config.js';
import { monitorDbPath, readWaStatus } from './monitor/runner.js';
import { createStore as createMonitorStore } from './monitor/store.js';
import { runTick } from './tick.js';
import { computeChanges } from './budget.js';
import { probeActivities } from './activities.js';
import { buildTracking, raisesByAd } from './tracking.js';
import { openStoreAt } from './store.js';
import { DEFAULT_TIMEZONE, historyInfo, redact, runAutoSync, runSync } from './sync.js';
import { addDays, daysBetween, isIsoDate, localParts } from './time.js';

export const TOKEN_ENV = 'AGENTAUTO_META_TOKEN';
const MAX_RANGE_DAYS = 370;
const GROUPS = ['ct', 'campaign', 'ad'];
const COMMANDS = ['sync', 'report', 'status', 'test-token', 'config-get', 'config-set', 'tick', 'decisions', 'decision-status', 'alerts-config-get', 'alerts-config-set', 'alerts-recent', 'wa-status', 'tracking', 'comprobante-country', 'activities-probe'];
const DECISION_STATUSES = ['pending', 'done', 'ignored'];

export class AdsError extends Error {}

// ["--from", "2026-10-01", "--stdin"] -> { from: "2026-10-01", stdin: true }
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function checkRange({ from, to }) {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new AdsError('Las fechas deben tener el formato AAAA-MM-DD.');
  if (from > to || daysBetween(from, to) > MAX_RANGE_DAYS) throw new AdsError(`El rango de fechas no es válido (máximo ${MAX_RANGE_DAYS} días).`);
}

const accountTimezone = (store) => store.getKv('account')?.timezone || DEFAULT_TIMEZONE;

export async function runAdsCommand(command, args, { dataDir, env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!COMMANDS.includes(command)) throw new AdsError(`Comando de anuncios no permitido: ${command}.`);
  const token = String(env[TOKEN_ENV] ?? '').trim();

  if (command === 'config-get') return { config: loadConfig(dataDir), defaults: DEFAULT_CONFIG };
  if (command === 'config-set') {
    try {
      return { config: saveConfig(dataDir, args ?? {}) };
    } catch (error) {
      if (error instanceof ConfigError) throw new AdsError(error.message);
      throw error;
    }
  }

  if (command === 'alerts-config-get') return { config: loadAlertsConfig(dataDir), defaults: ALERTS_DEFAULTS };
  if (command === 'alerts-config-set') {
    try {
      return { config: saveAlertsConfig(dataDir, args ?? {}) };
    } catch (error) {
      if (error instanceof AlertsConfigError) throw new AdsError(error.message);
      throw error;
    }
  }
  if (command === 'wa-status') return readWaStatus(dataDir);
  if (command === 'alerts-recent') {
    if (!existsSync(monitorDbPath(dataDir))) return { alerts: [], pausedUntil: null };
    const monitorStore = createMonitorStore(monitorDbPath(dataDir));
    try {
      return { alerts: monitorStore.recentAlerts(60), pausedUntil: monitorStore.getKv('pausedUntil') };
    } finally {
      monitorStore.close();
    }
  }

  const config = loadConfig(dataDir);

  if (command === 'test-token') {
    if (!token) throw new AdsError('Falta el token de Meta. Impórtalo o pégalo en la configuración de Anuncios.');
    const api = new MetaApi({ token, version: config.graphVersion, fetchImpl, now });
    try {
      const account = await fetchAccount(api, config.adAccountId);
      const store = openStoreAt(dataDir);
      try {
        store.setKv('account', { name: account.name, timezone: account.timezone || DEFAULT_TIMEZONE, currency: account.currency || config.currency });
      } finally {
        store.close();
      }
      return { accountName: account.name, currency: account.currency, timezone: account.timezone };
    } catch (error) {
      throw new AdsError(redact(friendlyMetaError(error), token));
    }
  }

  const store = openStoreAt(dataDir);
  try {
    if (command === 'sync' && (args.auto === true || args.auto === 'true')) {
      return await runAutoSync({ store, config, token, fetchImpl, now });
    }
    if (command === 'sync') {
      checkRange(args);
      return await runSync({ store, config, token, from: args.from, to: args.to, fetchImpl, now });
    }

    if (command === 'tick') return await runTick({ store, config, token, fetchImpl, now, force: args.force === true || args.force === 'true' });
    if (command === 'decisions') {
      return { decisions: store.decisions(), activitiesOk: store.getKv('activitiesOk'), lastSnapshot: store.getKv('lastSnapshot'), lifecycle: config.lifecycle };
    }
    if (command === 'decision-status') {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0 || !DECISION_STATUSES.includes(args.status)) throw new AdsError('La decisión o el estado no son válidos.');
      if (!store.setDecisionStatus(id, args.status, now())) throw new AdsError('No encuentro esa decisión.');
      return { id, status: args.status };
    }

    if (command === 'comprobante-country') {
      if (!/^[0-9a-f]{20}$/.test(String(args.key ?? '')) || !/^([A-Z]{2})?$/.test(String(args.code === true ? '' : (args.code ?? '')))) {
        throw new AdsError('El comprobante o el país no son válidos.');
      }
      store.setCountryOverride(args.key, args.code === true ? '' : (args.code ?? ''), now());
      return { key: args.key, country: args.code === true ? '' : (args.code ?? '') };
    }
    if (command === 'activities-probe') {
      if (!token) throw new AdsError('Falta el token de Meta.');
      const since = args.since && isIsoDate(args.since) ? args.since : '2026-10-01';
      try {
        return await probeActivities({ api: new MetaApi({ token, version: config.graphVersion, fetchImpl, now }), config, since });
      } catch (error) {
        throw new AdsError(redact(friendlyMetaError(error), token));
      }
    }

    const timezone = accountTimezone(store);
    const today = localParts(now(), timezone).date;
    const budgetChanges = () => computeChanges({ histories: store.budgetHistories(), events: store.budgetEvents() });
    if (command === 'tracking') {
      return buildTracking({ insights: store.insightsBetween(addDays(today, -60), today), ads: store.adsWithFirstSpend(), changes: budgetChanges(), config, today });
    }
    if (command === 'status') {
      return {
        tokenPresent: Boolean(token),
        lastSync: store.getKv('lastSync') ?? { meta: null, sheet: null, metaError: null, sheetError: null },
        counts: store.counts(),
        account: store.getKv('account'),
        history: historyInfo(store),
        today,
        dbPath: `${adsDir(dataDir)}/ads.db`,
      };
    }

    // report
    checkRange(args);
    if (args.country && args.country !== true && !/^(all|-|[A-Z]{2})$/.test(args.country)) throw new AdsError('El país debe ser un código de 2 letras o «all».');
    const group = args.group ?? 'ct';
    if (!GROUPS.includes(group)) throw new AdsError('La agrupación debe ser ct, campaign o ad.');
    const report = buildReport({
      insights: store.insightsBetween(args.from, args.to),
      comprobantes: store.comprobantesBetween(args.from, args.to),
      identities: store.identities(),
      ads: store.adsWithFirstSpend(),
      config,
      from: args.from,
      to: args.to,
      group,
      today,
      country: args.country === true ? '' : (args.country ?? ''),
      splitCountry: args.split === true || args.split === 'true',
      raises: raisesByAd({ insights: store.insightsBetween(addDays(today, -60), today), changes: budgetChanges(), today }),
    });
    return {
      ...report,
      today,
      timezone,
      history: historyInfo(store),
      lastSync: store.getKv('lastSync') ?? { meta: null, sheet: null, metaError: null, sheetError: null },
      settings: { campaignPrefix: config.campaignPrefix, flowPrefix: config.flowPrefix, validResult: config.validResult, autoRefreshMinutes: config.autoRefreshMinutes },
    };
  } finally {
    store.close();
  }
}
