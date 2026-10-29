// Sync: Meta (account, insights, ads/budgets) and the payments sheet -> SQLite. The two sources are independent:
// one failing never blocks the other, and the previous data stays in the store.
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { fetchAccount, fetchAds, fetchInsights } from './meta-data.js';
import { fetchSheetCsv, parseComprobantes } from './sheet.js';
import { localParts } from './time.js';

export const DEFAULT_TIMEZONE = 'America/Bogota';

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
    store.recordBudgets(ads, localParts(now(), timezone).date, now());
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
