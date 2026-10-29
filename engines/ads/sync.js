// Sync: Meta (account, insights, ads/budgets) and the payments sheet -> SQLite. The two sources are independent:
// one failing never blocks the other, and the previous data stays in the store.
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { fetchAccount, fetchAds, fetchInsights } from './meta-data.js';
import { fetchSheetCsv, parseComprobantes } from './sheet.js';
import { isMonitored } from './report.js';
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

export const redact = (value, token) => (token ? String(value ?? '').split(token).join('***') : String(value ?? ''));

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
    store.replaceComprobantes(parsed.rows, now());
    return { ok: true, rows: parsed.rows.length, skippedTests: parsed.skippedTests, skippedNoDate: parsed.skippedNoDate };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'SHEET', error: String(error?.message ?? error) };
  }
}

export async function runSync({ store, config, token, from, to, fetchImpl = globalThis.fetch, now = Date.now }) {
  const [meta, sheet] = await Promise.all([
    syncMeta({ store, config, token, from, to, fetchImpl, now }),
    syncSheet({ store, config, fetchImpl, now }),
  ]);
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
