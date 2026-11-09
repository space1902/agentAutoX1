// Read-only Graph API queries used by the ads engine, plus the normalization of their rows. Pure apart from `api`.
import { chunkRange, convertHour } from './time.js';

export const ACTION_CONVERSATION = 'onsite_conversion.messaging_conversation_started_7d';

const INSIGHT_FIELDS = 'campaign_name,campaign_id,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,actions';
// Hourly spend: one row per ad and hour of the advertiser's day. No country breakdown (Meta cannot combine them).
export const HOURLY_BREAKDOWN = 'hourly_stats_aggregated_by_advertiser_time_zone';
const HOURLY_FIELDS = 'campaign_name,campaign_id,adset_id,adset_name,ad_id,ad_name,spend';
const AD_FIELDS =
  'name,created_time,effective_status,campaign_id,adset_id,campaign{name,daily_budget,lifetime_budget},adset{name,daily_budget,lifetime_budget}';
const AD_STATUSES = ['ACTIVE', 'PAUSED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_BILLING_INFO', 'ARCHIVED'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  return actions.filter((a) => a?.action_type === type).reduce((sum, a) => sum + num(a.value), 0);
}

export function parseInsightRow(row) {
  return {
    date: row.date_start,
    adId: String(row.ad_id ?? ''),
    adName: row.ad_name ?? '',
    campaignId: String(row.campaign_id ?? ''),
    campaignName: row.campaign_name ?? '',
    adsetId: String(row.adset_id ?? ''),
    adsetName: row.adset_name ?? '',
    country: row.country && row.country !== 'unknown' ? String(row.country) : '',
    gasto: num(row.spend),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    mensajes: actionValue(row.actions, ACTION_CONVERSATION),
  };
}

// "08:00:00 - 08:59:59" -> 8 (null when unreadable).
export function parseHourBucket(value) {
  const m = /^\s*(\d{1,2}):/.exec(String(value ?? ''));
  const hour = m ? Number(m[1]) : NaN;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

// One hourly row. `date`/`hour` are in the REPORT timezone (the account's hour shifted from `accountTz` to `reportTz`);
// `srcDate`/`srcHour` keep what Meta said, so a re-sync replaces exactly the same rows. Null when the row is unusable.
export function parseHourlyRow(row, { accountTz, reportTz }) {
  const srcHour = parseHourBucket(row.hourly_stats_aggregated_by_advertiser_time_zone);
  if (srcHour === null || !row.date_start || !row.ad_id) return null;
  const shifted = convertHour(row.date_start, srcHour, accountTz, reportTz);
  return {
    srcDate: row.date_start, srcHour, date: shifted.date, hour: shifted.hour,
    adId: String(row.ad_id), adName: row.ad_name ?? '', campaignId: String(row.campaign_id ?? ''), campaignName: row.campaign_name ?? '',
    adsetId: String(row.adset_id ?? ''), adsetName: row.adset_name ?? '', gasto: num(row.spend),
  };
}

// Budgets arrive as strings in the currency minor unit; absent when the budget lives on the other level.
const budget = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function parseAdRow(row) {
  return {
    adId: String(row.id ?? ''),
    name: row.name ?? '',
    createdTime: row.created_time ?? '',
    effectiveStatus: row.effective_status ?? '',
    campaignId: String(row.campaign_id ?? row.campaign?.id ?? ''),
    campaignName: row.campaign?.name ?? '',
    campaignDailyBudget: budget(row.campaign?.daily_budget),
    campaignLifetimeBudget: budget(row.campaign?.lifetime_budget),
    adsetId: String(row.adset_id ?? row.adset?.id ?? ''),
    adsetName: row.adset?.name ?? '',
    adsetDailyBudget: budget(row.adset?.daily_budget),
    adsetLifetimeBudget: budget(row.adset?.lifetime_budget),
  };
}

export async function fetchAccount(api, accountId) {
  const row = await api.get(`/${accountId}`, { fields: 'name,timezone_name,currency,account_status' });
  return { name: row.name ?? '', timezone: row.timezone_name ?? '', currency: row.currency ?? '', status: row.account_status ?? null };
}

// Daily rows per ad. Ranges longer than 31 days are split so each request stays small.
export async function fetchInsights(api, accountId, since, until) {
  const rows = [];
  for (const chunk of chunkRange(since, until, 31)) {
    const page = await api.getAll(`/${accountId}/insights`, {
      level: 'ad',
      breakdowns: 'country',
      time_increment: 1,
      time_range: { since: chunk.since, until: chunk.until },
      fields: INSIGHT_FIELDS,
      limit: 500,
    });
    rows.push(...page.map(parseInsightRow));
  }
  return rows.filter((r) => r.adId && r.date);
}

// Hourly spend per ad (spend WITHOUT IVA, as Meta reports it). One paginated request per 31-day chunk.
export async function fetchHourlyInsights(api, accountId, since, until, { accountTz, reportTz }) {
  const rows = [];
  for (const chunk of chunkRange(since, until, 31)) {
    const page = await api.getAll(`/${accountId}/insights`, {
      level: 'ad',
      breakdowns: HOURLY_BREAKDOWN,
      time_increment: 1,
      time_range: { since: chunk.since, until: chunk.until },
      fields: HOURLY_FIELDS,
      limit: 500,
    });
    rows.push(...page.map((r) => parseHourlyRow(r, { accountTz, reportTz })));
  }
  return rows.filter(Boolean);
}

// Earliest day with spend in the whole account (monthly buckets of the maximum window Meta keeps).
export async function fetchFirstSpendDate(api, accountId) {
  const rows = await api.getAll(`/${accountId}/insights`, { level: 'account', date_preset: 'maximum', time_increment: 'monthly', fields: 'spend,date_start', limit: 100 });
  const dates = rows.filter((r) => Number(r.spend) > 0).map((r) => r.date_start).sort();
  return dates[0] ?? null;
}

export async function fetchAds(api, accountId) {
  const rows = await api.getAll(`/${accountId}/ads`, { fields: AD_FIELDS, effective_status: AD_STATUSES, limit: 500 });
  return rows.map(parseAdRow).filter((r) => r.adId);
}


// Account activity log (budget edits). Needs the same ads_read permission; failures are handled by the caller.
export async function fetchActivities(api, accountId, sinceDate) {
  return api.getAll(`/${accountId}/activities`, { fields: 'event_type,event_time,object_id,object_name,extra_data', since: sinceDate, limit: 500 });
}
