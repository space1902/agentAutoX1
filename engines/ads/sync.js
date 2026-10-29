// Sync: Meta (account, insights, ads/budgets) and the payments sheet -> SQLite. The two sources are independent:
// one failing never blocks the other, and the previous data stays in the store.
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { syncActivities } from './activities.js';
import { deriveCountry } from './country.js';
import { fetchAccount, fetchAds, fetchFirstSpendDate, fetchInsights } from './meta-data.js';
import { redact } from './redact.js';
import { fetchSheetCsv, parseComprobantes } from './sheet.js';
import { isMonitored } from './report.js';
import { parseDateToIso } from './parse.js';
import { addDays, daysBetween, localParts } from './time.js';

export const DEFAULT_TIMEZONE = 'America/Bogota';

const MAX_LOOKBACK_DAYS = 120;

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

async function syncMeta({ store, config, token, from, to, fetchImpl, now }) {
  if (!token) {
    return { ok: false, code: 'NO_TOKEN', error: 'Falta el token de Meta. Impórtalo o pégalo en la configuración de Anuncios.' };
  }
  const api = new MetaApi({ token, version: config.graphVersion, fetchImpl, now });
  try {
    const account = await fetchAccount(api, config.adAccountId);
    const timezone = account.timezone || store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
    store.setKv('account', { name: account.name, timezone, currency: account.currency || config.currency });

    const insights = await fetchInsights(api, config.adAccountId, from, to);
    store.upsertInsights(insights, now());

    const ads = await fetchAds(api, config.adAccountId);
    store.upsertAds(ads, now());
    const today = localParts(now(), timezone).date;
    store.recordBudgets(ads, today, now());
    store.refreshFirstSpend();

    const plan = lookbackPlan({ ads, first: store.firstSpendMap(), checked: store.getKv('lookbackChecked') ?? [], from, prefix: config.campaignPrefix, today });
    if (plan && plan.since <= plan.until) {
      store.upsertInsights(await fetchInsights(api, config.adAccountId, plan.since, plan.until), now());
      store.refreshFirstSpend();
    }
    if (plan) store.setKv('lookbackChecked', [...new Set([...(store.getKv('lookbackChecked') ?? []), ...plan.ids])].slice(-2000));
    return { ok: true, insightRows: insights.length, ads: ads.length };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'META', error: redact(friendlyMetaError(error), token) };
  }
}

async function syncSheet({ store, config, fetchImpl, now }) {
  try {
    const csv = await fetchSheetCsv({ sheetId: config.sheetId, tab: config.sheetTab, fetchImpl });
    const parsed = parseComprobantes(csv);
    store.syncComprobantes(parsed.rows, now());
    return { ok: true, rows: parsed.rows.length, skippedTests: parsed.skippedTests, skippedNoDate: parsed.skippedNoDate };
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

export async function runSync({ store, config, token, from, to, fetchImpl = globalThis.fetch, now = Date.now }) {
  const [meta, sheet] = await Promise.all([
    syncMeta({ store, config, token, from, to, fetchImpl, now }),
    syncSheet({ store, config, fetchImpl, now }),
  ]);
  deriveStoredCountries(store, config);
  const previous = store.getKv('lastSync') ?? {};
  store.setKv('lastSync', {
    meta: meta.ok ? now() : (previous.meta ?? null),
    sheet: sheet.ok ? now() : (previous.sheet ?? null),
    metaError: meta.ok ? null : meta.error,
    sheetError: sheet.ok ? null : sheet.error,
  });
  const timezone = store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
  return { range: { from, to }, today: localParts(now(), timezone).date, syncedAt: now(), meta, sheet };
}

const BACKFILL_RECENT_DAYS = 3;

// Incremental sync with a one-time history backfill.
//  - First run (or after the insights table was rebuilt): everything from the history start, month by month.
//    The start is the configured "Historial desde", else the earliest day found in the payments sheet or in Meta.
//  - Afterwards: the last 3 days (Meta restates recent days) plus today.
export async function runAutoSync({ store, config, token, fetchImpl = globalThis.fetch, now = Date.now }) {
  const timezone = store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
  const today = localParts(now(), timezone).date;
  if (store.insightsRebuilt && store.getKv('backfillDone')) store.setKv('backfillDone', null);
  let backfill = store.getKv('backfillDone');
  const wantedStart = config.historyFrom || null;
  if (backfill && wantedStart && wantedStart < backfill.from) backfill = null; // the user asked for an earlier history

  let from = addDays(today, -BACKFILL_RECENT_DAYS);
  if (!backfill) {
    let sheetMin = null;
    try {
      const parsed = parseComprobantes(await fetchSheetCsv({ sheetId: config.sheetId, tab: config.sheetTab, fetchImpl }));
      sheetMin = parsed.rows.map((r) => parseDateToIso(r.registered)).filter(Boolean).sort()[0] ?? null;
    } catch {
      /* the regular sync below reports the sheet problem */
    }
    let metaMin = null;
    if (token && !wantedStart) {
      try {
        metaMin = await fetchFirstSpendDate(new MetaApi({ token, version: config.graphVersion, fetchImpl, now }), config.adAccountId);
      } catch {
        /* same: reported by the regular sync */
      }
    }
    const detected = [metaMin, sheetMin].filter(Boolean).sort()[0] ?? null;
    const start = wantedStart
      ? { date: wantedStart, source: 'config' }
      : (store.getKv('historyStart') ?? (detected ? { date: detected, source: 'auto' } : { date: addDays(today, -30), source: 'default' }));
    store.setKv('historyStart', start);
    from = start.date;
  }

  const result = await runSync({ store, config, token, from, to: today, fetchImpl, now });
  result.backfilled = false;
  if (!backfill && result.meta.ok) {
    store.setKv('backfillDone', { from, at: now() });
    result.backfilled = true;
    if (token) {
      const api = new MetaApi({ token, version: config.graphVersion, fetchImpl, now });
      result.activities = await syncActivities({ api, store, config, since: from, timezone: store.getKv('account')?.timezone || timezone, token });
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
