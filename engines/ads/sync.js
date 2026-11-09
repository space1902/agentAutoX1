// Sync: Meta (account, insights, ads/budgets) and the payments sheet -> SQLite. The two sources are independent:
// one failing never blocks the other, and the previous data stays in the store.
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { syncActivities } from './activities.js';
import { deriveCountry } from './country.js';
import { fetchAccount, fetchAds, fetchFirstSpendDate, fetchHourlyInsights, fetchInsights } from './meta-data.js';
import { PRINCIPAL_ID, redactAll, targetsFor } from './portfolios.js';
import { redact } from './redact.js';
import { fetchSheetCsv, parseComprobantes } from './sheet.js';
import { isMonitored } from './report.js';
import { parseDateToIso } from './parse.js';
import { addDays, daysBetween, localParts } from './time.js';

export const DEFAULT_TIMEZONE = 'America/Bogota';

const MAX_LOOKBACK_DAYS = 120;
// Hourly spend is only refreshed for the most recent days of the range the sync already covers (the incremental window is
// 4 days; a manual or backfill range is capped here), so it costs one request per account per sync.
export const HOURLY_MAX_DAYS = 7;

// Ads already seen before `from` whose first spending day is still unknown: look back to their creation date
// (once per ad) so "day 1" (first day with spend > 0) is reliable.
export function lookbackPlan({ ads, first, checked, from, prefix, today }) {
  const ids = [];
  let start = null;
  for (const ad of ads) {
    const created = String(ad.createdTime ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(created) || created >= from) continue;
    if ((first[ad.adId] && first[ad.adId] < from) || checked.includes(ad.adId) || !isMonitored(ad.campaignName, prefix)) continue;
    ids.push(ad.adId);
    if (!start || created < start) start = created;
  }
  if (!ids.length) return null;
  const floor = addDays(today, -MAX_LOOKBACK_DAYS);
  return { ids, since: start < floor ? floor : start, until: addDays(from, -1) };
}

export { redact };

// Token of the portfolio that owns an account. `tokens` is { portfolioId: token }; the single legacy `token` belongs to
// the principal portfolio (older callers and data dirs).
export const tokenOfTarget = ({ tokens, token }, target) => String(tokens?.[target.portfolioId] ?? (target.portfolioId === PRINCIPAL_ID ? token : '') ?? '').trim();

// Timezone of an account's "today": what Meta told us, else the config, else the legacy single record, else Bogota.
export const timezoneFor = (store, target) =>
  store.getKv(`account:${target.accountId}`)?.timezone || target.timezone || store.getKv('account')?.timezone || DEFAULT_TIMEZONE;

const labelOf = (target) => (target.name && target.name !== target.accountId ? `${target.name} (${target.accountId})` : target.accountId);

// One account: details, insights, ads/budgets and first-spend lookback. Never throws (the caller keeps going with the next account).
async function syncAccount({ store, config, target, token, from, to, fetchImpl, now }) {
  const base = { accountId: target.accountId, portfolioId: target.portfolioId, name: target.name };
  if (!token) {
    return { ...base, ok: false, code: 'NO_TOKEN', error: 'Falta el token de Meta. Impórtalo o pégalo en la configuración de Anuncios.' };
  }
  const id = target.accountId;
  const api = new MetaApi({ token, version: config.graphVersion, fetchImpl, now });
  try {
    const account = await fetchAccount(api, id);
    const timezone = account.timezone || timezoneFor(store, target);
    store.setAccountInfo(id, { name: account.name, timezone, currency: account.currency || target.currency || config.currency }, { primary: id === config.adAccountId });

    const insights = await fetchInsights(api, id, from, to);
    store.upsertInsights(insights, now(), id);

    // Hourly spend: same cycle, same days, one extra request. A failure never fails the account (daily data is already saved).
    let hourlyRows = 0;
    let hourlyError = null;
    try {
      const hourlyFrom = addDays(to, -(HOURLY_MAX_DAYS - 1));
      const hourly = await fetchHourlyInsights(api, id, from > hourlyFrom ? from : hourlyFrom, to, { accountTz: timezone, reportTz: DEFAULT_TIMEZONE });
      store.upsertHourlyInsights(hourly, now(), id);
      hourlyRows = hourly.length;
    } catch (error) {
      hourlyError = redact(friendlyMetaError(error), token);
    }

    const ads = await fetchAds(api, id);
    store.upsertAds(ads, now(), id);
    const today = localParts(now(), timezone).date;
    store.recordBudgets(ads, today, now(), id);
    store.refreshFirstSpend();

    const plan = lookbackPlan({ ads, first: store.firstSpendMap(), checked: store.getKv('lookbackChecked') ?? [], from, prefix: config.campaignPrefix, today });
    if (plan && plan.since <= plan.until) {
      store.upsertInsights(await fetchInsights(api, id, plan.since, plan.until), now(), id);
      store.refreshFirstSpend();
    }
    if (plan) store.setKv('lookbackChecked', [...new Set([...(store.getKv('lookbackChecked') ?? []), ...plan.ids])].slice(-2000));
    return { ...base, ok: true, insightRows: insights.length, ads: ads.length, hourlyRows, ...(hourlyError ? { hourlyError } : {}) };
  } catch (error) {
    return { ...base, ok: false, code: error?.code ?? 'META', error: redact(friendlyMetaError(error), token) };
  }
}

// Every requested account, one after the other (gentle on Meta's rate limits). One failing never stops the rest.
// `rangeFor(target)` may give an account its own { from, to } (the first-time backfill).
async function syncMeta({ store, config, targets, tokens, token, from, to, rangeFor, fetchImpl, now }) {
  const results = [];
  for (const target of targets) {
    const range = rangeFor?.(target) ?? { from, to };
    const result = await syncAccount({ store, config, target, token: tokenOfTarget({ tokens, token }, target), from: range.from, to: range.to, fetchImpl, now });
    results.push(result);
  }
  const failed = results.filter((r) => !r.ok);
  const everything = [...Object.values(tokens ?? {}), token].filter(Boolean);
  const message = failed.map((r) => (results.length > 1 ? `${labelOf(r)}: ${r.error}` : r.error)).join(' · ');
  return {
    ok: results.length > 0 && failed.length === 0,
    partial: results.some((r) => r.ok),
    ...(failed.length ? { code: failed[0].code, error: redactAll(message, everything) } : {}),
    insightRows: results.reduce((n, r) => n + (r.insightRows ?? 0), 0),
    ads: results.reduce((n, r) => n + (r.ads ?? 0), 0),
    accounts: results.map(({ accountId, portfolioId, ok, code, error, insightRows, ads }) => ({ accountId, portfolioId, ok, ...(ok ? { insightRows, ads } : { code, error }) })),
  };
}

async function syncSheet({ store, config, fetchImpl, now }) {
  try {
    const csv = await fetchSheetCsv({ sheetId: config.sheetId, tab: config.sheetTab, fetchImpl });
    const parsed = parseComprobantes(csv);
    store.syncComprobantes(parsed.rows, now());
    const warning = parsed.rows.length === 0 ? 'La hoja llegó vacía; no se marcó nada como eliminado.' : undefined;
    return { ok: true, rows: parsed.rows.length, skippedTests: parsed.skippedTests, skippedNoDate: parsed.skippedNoDate, ...(warning ? { warning } : {}) };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'SHEET', error: String(error?.message ?? error) };
  }
}

// Stores the derived country (phone prefix, then the ad campaign, then the flow) of every payment that has no
// manual override. Cheap: a few hundred rows.
export function deriveStoredCountries(store, config) {
  const identities = store.identities();
  const changes = [];
  for (const r of store.comprobantesBetween('0000-01-01', '9999-12-31')) {
    if (r.countrySource === 'manual') continue;
    const d = deriveCountry({ phone: r.phone, campaignName: identities[r.adId]?.campaignName, flow: r.flow }, config.countryWords);
    if (d.country !== r.country || d.source !== r.countrySource) changes.push({ key: r.key, country: d.country, source: d.source });
  }
  if (changes.length) store.setComprobanteCountries(changes);
  return changes.length;
}

// Accounts to work on: the explicit `targets`, else every configured account (or the legacy single account).
const resolveTargets = (config, targets) => targets ?? targetsFor(config, null);

export async function runSync({ store, config, token, tokens, targets, rangeFor, from, to, fetchImpl = globalThis.fetch, now = Date.now }) {
  const list = resolveTargets(config, targets);
  const [meta, sheet] = await Promise.all([
    syncMeta({ store, config, targets: list, tokens, token, from, to, rangeFor, fetchImpl, now }),
    syncSheet({ store, config, fetchImpl, now }),
  ]);
  deriveStoredCountries(store, config);
  const previous = store.getKv('lastSync') ?? {};
  const at = now();
  const accounts = { ...(previous.accounts ?? {}) };
  for (const a of meta.accounts) accounts[a.accountId] = a.ok ? { ok: true, at, error: null } : { ok: false, at: accounts[a.accountId]?.at ?? null, error: a.error };
  store.setKv('lastSync', {
    // Some accounts failing does not hide that the others were refreshed; the failures are listed in metaError / accounts.
    meta: meta.ok || meta.partial ? at : (previous.meta ?? null),
    sheet: sheet.ok ? at : (previous.sheet ?? null),
    metaError: meta.ok ? null : meta.error,
    sheetError: sheet.ok ? null : sheet.error,
    accounts,
  });
  const timezone = list[0] ? timezoneFor(store, list[0]) : DEFAULT_TIMEZONE;
  return { range: { from, to }, today: localParts(now(), timezone).date, syncedAt: now(), meta, sheet, accounts: meta.accounts };
}

const BACKFILL_RECENT_DAYS = 3;

const backfillKey = (accountId) => `backfillDone:${accountId}`;

// Incremental sync with a one-time history backfill PER ACCOUNT.
//  - First run of an account (or after the insights table was rebuilt): everything from its history start, month by month.
//    The start is the configured "Historial desde", else the earliest day with spend found in Meta (the principal account
//    also looks at the payments sheet).
//  - Afterwards: the last 3 days (Meta restates recent days) plus today.
export async function runAutoSync({ store, config, token, tokens, targets, fetchImpl = globalThis.fetch, now = Date.now }) {
  const list = resolveTargets(config, targets);
  const wantedStart = config.historyFrom || null;
  if (store.insightsRebuilt) {
    for (const r of store.db.prepare("SELECT key FROM kv WHERE key = 'backfillDone' OR key LIKE 'backfillDone:%'").all()) store.setKv(r.key, null);
  }

  // Per account: its backfill marker (the old global marker belongs to the principal account) and its own "today".
  const plans = list.map((target) => {
    const legacy = target.accountId === config.adAccountId;
    let backfill = store.getKv(backfillKey(target.accountId)) ?? (legacy ? store.getKv('backfillDone') : null);
    if (backfill && wantedStart && wantedStart < backfill.from) backfill = null; // the user asked for an earlier history
    return { target, legacy, backfill, today: localParts(now(), timezoneFor(store, target)).date, token: tokenOfTarget({ tokens, token }, target) };
  });

  let sheetMin = null;
  if (plans.some((p) => !p.backfill)) {
    try {
      const parsed = parseComprobantes(await fetchSheetCsv({ sheetId: config.sheetId, tab: config.sheetTab, fetchImpl }));
      sheetMin = parsed.rows.map((r) => parseDateToIso(r.registered)).filter(Boolean).sort()[0] ?? null;
    } catch {
      /* the regular sync below reports the sheet problem */
    }
  }
  for (const plan of plans) {
    plan.from = addDays(plan.today, -BACKFILL_RECENT_DAYS);
    if (plan.backfill) continue;
    let metaMin = null;
    if (plan.token && !wantedStart) {
      try {
        metaMin = await fetchFirstSpendDate(new MetaApi({ token: plan.token, version: config.graphVersion, fetchImpl, now }), plan.target.accountId);
      } catch {
        /* same: reported by the regular sync */
      }
    }
    let start;
    if (wantedStart) start = { date: wantedStart, source: 'config' };
    else if (plan.legacy) {
      const detected = [metaMin, sheetMin].filter(Boolean).sort()[0] ?? null;
      start = store.getKv('historyStart') ?? (detected ? { date: detected, source: 'auto' } : { date: addDays(plan.today, -30), source: 'default' });
    } else {
      start = metaMin ? { date: metaMin, source: 'auto' } : { date: addDays(plan.today, -30), source: 'default' };
    }
    const known = store.getKv('historyStart');
    if (plan.legacy || wantedStart || !known || start.date < known.date) store.setKv('historyStart', start);
    plan.from = start.date;
  }
  const byAccount = new Map(plans.map((p) => [p.target.accountId, p]));
  const lastDay = plans.map((p) => p.today).sort().at(-1) ?? localParts(now(), DEFAULT_TIMEZONE).date;

  const result = await runSync({
    store, config, token, tokens, targets: list, from: plans.map((p) => p.from).sort()[0] ?? lastDay, to: lastDay, fetchImpl, now,
    rangeFor: (target) => ({ from: byAccount.get(target.accountId).from, to: byAccount.get(target.accountId).today }),
  });
  result.backfilled = false;
  const okIds = new Set(result.meta.accounts.filter((a) => a.ok).map((a) => a.accountId));
  for (const plan of plans) {
    if (plan.backfill || !okIds.has(plan.target.accountId)) continue;
    const marker = { from: plan.from, at: now() };
    store.setKv(backfillKey(plan.target.accountId), marker);
    store.setKv('backfillDone', marker); // "something was backfilled" for the Historial line
    result.backfilled = true;
    if (plan.token) {
      const api = new MetaApi({ token: plan.token, version: config.graphVersion, fetchImpl, now });
      const activities = await syncActivities({ api, store, config, since: plan.from, timezone: timezoneFor(store, plan.target), token: plan.token, accountId: plan.target.accountId });
      result.activities = result.activities ? { ...activities, ok: result.activities.ok && activities.ok } : activities;
    }
  }
  result.history = historyInfo(store);
  return result;
}

// What the database holds, for the "Historial" line of the UI.
export function historyInfo(store) {
  const stats = store.historyStats();
  const start = store.getKv('historyStart');
  return {
    from: start?.date ?? stats.insightsFrom,
    source: start?.source ?? null,
    firstData: stats.insightsFrom,
    lastData: stats.insightsTo,
    days: stats.insightDays,
    vouchers: stats.voucherRows,
    backfill: store.getKv('backfillDone'),
  };
}
