// Normalizes Graph API insight rows into plain numeric objects. Pure.
export const ACTION_PURCHASE = 'onsite_conversion.purchase';
export const ACTION_CONVERSATION = 'onsite_conversion.messaging_conversation_started_7d';
export const HOURLY_BREAKDOWN = 'hourly_stats_aggregated_by_advertiser_time_zone';

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
    adId: String(row.ad_id ?? ''),
    adName: row.ad_name ?? '',
    campaignId: row.campaign_id ?? '',
    campaignName: row.campaign_name ?? '',
    adsetId: row.adset_id ?? '',
    spend: num(row.spend),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    ctr: num(row.ctr),
    cpm: num(row.cpm),
    frequency: num(row.frequency),
    purchases: actionValue(row.actions, ACTION_PURCHASE),
    conversations: actionValue(row.actions, ACTION_CONVERSATION),
  };
}

// "07:00:00 - 07:59:59" -> 7
export function hourFromBreakdown(value) {
  const match = /^(\d{1,2}):/.exec(String(value ?? ''));
  return match ? Number(match[1]) : null;
}

export function parseHourlyRow(row) {
  return {
    ...parseInsightRow(row),
    date: row.date_start,
    hour: hourFromBreakdown(row[HOURLY_BREAKDOWN]),
  };
}

export function isMonitored(campaignName, prefix) {
  if (!campaignName || !prefix) return false;
  return String(campaignName).toUpperCase().startsWith(String(prefix).toUpperCase());
}
