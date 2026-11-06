// Command layer of the ads engine (used by ads-cli.js and the tests). The Meta token is read ONLY from the
// AGENTAUTO_META_TOKEN environment variable; it is never stored, logged or returned.
import { ACCOUNT_RE, SelectionError, accountsOf, allTokens, parseAccountsArg, redactAll, slugify, targetsFor, tokenFor } from './portfolios.js';
import { DEFAULT_CONFIG, ConfigError, adsDir, ensureMigrated, loadConfig, saveConfig } from './config.js';
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { ScopeError, accountMetaOf, foreignCurrencyAccounts, parseNamePrefixes } from './scope.js';
import { fetchAccount } from './meta-data.js';
import { fxSummary, refreshFxRates, resolveRate } from './fx.js';
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
// 'ct' is the legacy name of the campaign grouping (the report never merges campaigns by CT code anymore).
const GROUPS = ['campaign', 'ct', 'ad'];
const COMMANDS = ['sync', 'report', 'vouchers', 'status', 'test-token', 'config-get', 'config-set', 'tick', 'decisions', 'decision-status', 'alerts-config-get', 'alerts-config-set', 'alerts-recent', 'wa-status', 'tracking', 'comprobante-country', 'comprobante-accept', 'activities-probe', 'fx-refresh', 'portfolio-add', 'account-add'];
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

// Config countries with the live rate (latest saved) as rateToCop where the country follows it: what the SQL views use.
function effectiveCountries(config, fxRates) {
  return Object.fromEntries(
    Object.entries(config.countries).map(([code, c]) => {
      const r = resolveRate(config, code, '9999-12-31', fxRates);
      return [code, r.mode === 'auto' ? { ...c, rateToCop: r.rate } : c];
    }),
  );
}

const accountTimezone = (store) => store.getKv('account')?.timezone || DEFAULT_TIMEZONE;

// Spanish text for a failed account lookup (never includes a token: MetaApi already scrubbed the message).
function friendlyAccountError(error) {
  const code = error?.code;
  if (code === 100 || code === 803 || error?.status === 404) {
    return 'No encuentro esa cuenta publicitaria en Meta, o este portafolio no tiene permiso para verla. Revisa el número y que la cuenta esté asignada al usuario del sistema de este portafolio.';
  }
  return friendlyMetaError(error);
}

// Selection / filter arguments of sync, report and vouchers; invalid values become AdsError (Spanish message).
function scopeArgs(args, config) {
  try {
    return { selection: parseAccountsArg(args.accounts, config), names: parseNamePrefixes(args.name) };
  } catch (error) {
    if (error instanceof SelectionError || error instanceof ScopeError) throw new AdsError(error.message);
    throw error;
  }
}

function uniqueSlug(config, name) {
  const taken = new Set(config.portfolios.map((p) => p.id));
  if (taken.size === 0) return 'principal'; // the first portfolio keeps the original token entry
  const base = slugify(name);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 37)}-${n}`;
  return slug;
}

export async function runAdsCommand(command, args, { dataDir, env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!COMMANDS.includes(command)) throw new AdsError(`Comando de anuncios no permitido: ${command}.`);
  const token = String(env[TOKEN_ENV] ?? '').trim();

  ensureMigrated(dataDir);
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
  const tokens = allTokens(env, config);
  const everyToken = [...Object.values(tokens), token];

  // Token check of one portfolio: who the token belongs to and which ad accounts it can see (to offer them as quick picks).
  if (command === 'test-token') {
    const slug = String(args.portfolio ?? '').trim() || (config.portfolios.some((p) => p.id === 'principal') ? 'principal' : (config.portfolios[0]?.id ?? 'principal'));
    const portfolioToken = tokenFor(env, slug);
    if (!portfolioToken) throw new AdsError('Falta el token de Meta de este portafolio. Pégalo en la configuración de Anuncios.');
    const api = new MetaApi({ token: portfolioToken, version: config.graphVersion, fetchImpl, now });
    try {
      const me = await api.get('/me', { fields: 'id,name' });
      let accounts = [];
      try {
        const rows = await api.getAll('/me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status', limit: 100 });
        accounts = rows.filter((r) => ACCOUNT_RE.test(String(r.id ?? ''))).map((r) => ({ id: r.id, name: r.name ?? '', currency: r.currency ?? '', timezone: r.timezone_name ?? '', status: r.account_status ?? null }));
      } catch {
        /* listing is a nicety: a token that can read /me but not list accounts is still valid */
      }
      return { portfolio: slug, name: me.name ?? '', id: String(me.id ?? ''), accounts };
    } catch (error) {
      throw new AdsError(redactAll(friendlyMetaError(error), everyToken));
    }
  }

  // Creates a portfolio (its token is stored by the app, never here). Returns the slug the token entry is derived from.
  if (command === 'portfolio-add') {
    const name = String(args.name ?? '').trim();
    if (!name) throw new AdsError('El portafolio necesita un nombre.');
    const id = uniqueSlug(config, name);
    try {
      const saved = saveConfig(dataDir, { portfolios: [...config.portfolios, { id, name, accounts: [] }] });
      return { portfolio: { id, name: saved.portfolios.find((p) => p.id === id).name }, config: saved };
    } catch (error) {
      if (error instanceof ConfigError) throw new AdsError(error.message);
      throw error;
    }
  }

  // Adds an ad account to a portfolio ONLY after Meta confirms the portfolio's token can read it; nothing is saved otherwise.
  if (command === 'account-add') {
    const portfolio = config.portfolios.find((p) => p.id === String(args.portfolio ?? ''));
    if (!portfolio) throw new AdsError('No encuentro ese portafolio.');
    const raw = String(args.account ?? '').trim();
    const id = /^\d+$/.test(raw) ? `act_${raw}` : raw;
    if (!ACCOUNT_RE.test(id)) throw new AdsError('La cuenta publicitaria debe verse como act_1234567890.');
    const owner = config.portfolios.find((p) => p.accounts.some((a) => a.id === id));
    if (owner) throw new AdsError(`Esa cuenta ya está en tu configuración (portafolio «${owner.name}»).`);
    const portfolioToken = tokenFor(env, portfolio.id);
    if (!portfolioToken) throw new AdsError(`Falta el token de Meta del portafolio «${portfolio.name}». Pégalo antes de agregar cuentas.`);
    let info;
    try {
      info = await fetchAccount(new MetaApi({ token: portfolioToken, version: config.graphVersion, fetchImpl, now }), id);
    } catch (error) {
      throw new AdsError(redactAll(friendlyAccountError(error), everyToken));
    }
    const account = { id, name: String(args.name ?? '').trim() || info.name || id, currency: info.currency || '', timezone: info.timezone || '' };
    try {
      const saved = saveConfig(dataDir, { portfolios: config.portfolios.map((p) => (p.id === portfolio.id ? { ...p, accounts: [...p.accounts, account] } : p)) });
      const store = openStoreAt(dataDir);
      try {
        store.setAccountInfo(id, { name: info.name || account.name, timezone: account.timezone || DEFAULT_TIMEZONE, currency: account.currency || config.currency });
      } finally {
        store.close();
      }
      return { account: saved.portfolios.find((p) => p.id === portfolio.id).accounts.find((a) => a.id === id), accountStatus: info.status, config: saved };
    } catch (error) {
      if (error instanceof ConfigError) throw new AdsError(error.message);
      throw error;
    }
  }

  const store = openStoreAt(dataDir);
  try {
    // Views for the Analista see the live rate (latest saved) wherever the country follows it.
    const fxRates = store.fxRates();
    store.setCountryRates(effectiveCountries(config, fxRates));
    store.setSpendVat(config.spendVatPct);
    store.setExcludedAccounts(foreignCurrencyAccounts(config, store));
    // Live exchange rates: fetched on each data refresh (the app calls this; there is no background polling). Needs no
    // token; a failed fetch keeps the last saved rate and is reported in `errors`.
    if (command === 'fx-refresh') {
      const tz = accountTimezone(store);
      const date = localParts(now(), tz).date;
      const result = await refreshFxRates({ store, config, today: date, fetchImpl, now });
      const saved = store.fxRates();
      store.setCountryRates(effectiveCountries(config, saved));
      return { ...result, today: date, fx: fxSummary(config, saved, date) };
    }
    if (command === 'sync' && (args.auto === true || args.auto === 'true')) {
      return await runAutoSync({ store, config, token, tokens, targets: targetsFor(config, scopeArgs(args, config).selection), fetchImpl, now });
    }
    if (command === 'sync') {
      checkRange(args);
      return await runSync({ store, config, token, tokens, targets: targetsFor(config, scopeArgs(args, config).selection), from: args.from, to: args.to, fetchImpl, now });
    }

    if (command === 'tick') {
      const result = await runTick({ store, config, token, tokens, fetchImpl, now, force: args.force === true || args.force === 'true' });
      // The Analista measures the real outcome of its recommendations once a day. It never blocks or breaks the tick.
      try {
        const { runDailyLearning } = await import('../agent/learning-daily.js');
        result.learning = runDailyLearning({ dataDir, now: now() });
      } catch (error) {
        result.learning = { error: String(error?.message ?? error) };
      }
      return result;
    }
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
    // Accept (or undo with --undo) a payment by hand. Only the local database changes; the sheet is never written.
    if (command === 'comprobante-accept') {
      if (!/^[0-9a-f]{20}$/.test(String(args.key ?? ''))) throw new AdsError('El comprobante no es válido.');
      const accepted = !(args.undo === true || args.undo === 'true');
      if (!store.setAccepted(args.key, accepted, now())) throw new AdsError('No encuentro ese comprobante.');
      return { key: args.key, accepted };
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
        // True when ANY portfolio has a token; the per-portfolio presence is listed apart (never the values).
        tokenPresent: Boolean(token) || Object.keys(tokens).length > 0,
        portfolios: config.portfolios.map((p) => ({ id: p.id, tokenPresent: Boolean(tokens[p.id]) })),
        lastSync: store.getKv('lastSync') ?? { meta: null, sheet: null, metaError: null, sheetError: null },
        counts: store.counts(),
        account: store.getKv('account'),
        history: historyInfo(store),
        today,
        dbPath: `${adsDir(dataDir)}/ads.db`,
      };
    }

    // vouchers: the payments list of any range (the Comprobantes card has its own dates). Same rules as the report, but
    // without Meta data, so it is cheap.
    if (command === 'vouchers') {
      checkRange(args);
      if (args.country && args.country !== true && !/^(all|-|[A-Z]{2})$/.test(args.country)) throw new AdsError('El país debe ser un código de 2 letras o «all».');
      const scope = scopeArgs(args, config);
      const { comprobantes, reviewCount, range, notes } = buildReport({
        insights: [],
        comprobantes: store.comprobantesBetween(args.from, args.to),
        identities: store.identities(),
        ads: scope.selection.all && !scope.names.length ? {} : store.adsMap(),
        accounts: scope.selection,
        names: scope.names,
        accountMeta: accountMetaOf(config, store),
        config,
        fxRates,
        from: args.from,
        to: args.to,
        group: 'campaign',
        today,
        country: args.country === true ? '' : (args.country ?? ''),
      });
      return { range, comprobantes, reviewCount, notes };
    }

    // report
    checkRange(args);
    if (args.country && args.country !== true && !/^(all|-|[A-Z]{2})$/.test(args.country)) throw new AdsError('El país debe ser un código de 2 letras o «all».');
    const group = args.group ?? 'campaign';
    if (!GROUPS.includes(group)) throw new AdsError('La agrupación debe ser campaign o ad.');
    const scope = scopeArgs(args, config);
    // Insights and identities stay unfiltered here: the report needs every account to know which ad a payment belongs to.
    const report = buildReport({
      accounts: scope.selection,
      names: scope.names,
      accountMeta: accountMetaOf(config, store),
      insights: store.insightsBetween(args.from, args.to),
      comprobantes: store.comprobantesBetween(args.from, args.to),
      identities: store.identities(),
      ads: store.adsWithFirstSpend(),
      config,
      fxRates,
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
