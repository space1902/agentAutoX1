// Command layer of the ads engine (used by ads-cli.js and the tests). The Meta token is read ONLY from the
// AGENTAUTO_META_TOKEN environment variable; it is never stored, logged or returned.
import { DEFAULT_CONFIG, ConfigError, adsDir, loadConfig, saveConfig } from './config.js';
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { fetchAccount } from './meta-data.js';
import { buildReport } from './report.js';
import { runTick } from './tick.js';
import { openStoreAt } from './store.js';
import { DEFAULT_TIMEZONE, redact, runSync } from './sync.js';
import { daysBetween, isIsoDate, localParts } from './time.js';

export const TOKEN_ENV = 'AGENTAUTO_META_TOKEN';
const MAX_RANGE_DAYS = 370;
const GROUPS = ['ct', 'campaign', 'ad'];
const COMMANDS = ['sync', 'report', 'status', 'test-token', 'config-get', 'config-set', 'tick', 'decisions', 'decision-status'];
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

    const timezone = accountTimezone(store);
    const today = localParts(now(), timezone).date;
    if (command === 'status') {
      return {
        tokenPresent: Boolean(token),
        lastSync: store.getKv('lastSync') ?? { meta: null, sheet: null, metaError: null, sheetError: null },
        counts: store.counts(),
        account: store.getKv('account'),
        today,
        dbPath: `${adsDir(dataDir)}/ads.db`,
      };
    }

    // report
    checkRange(args);
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
    });
    return {
      ...report,
      today,
      timezone,
      lastSync: store.getKv('lastSync') ?? { meta: null, sheet: null, metaError: null, sheetError: null },
      settings: { campaignPrefix: config.campaignPrefix, flowPrefix: config.flowPrefix, validResult: config.validResult, autoRefreshMinutes: config.autoRefreshMinutes },
    };
  } finally {
    store.close();
  }
}
