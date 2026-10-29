// Read-only Graph API queries used by the monitor. Each call is paginated and requests only the
// fields it needs, to keep the rate-limit footprint small (3 reads per poll).
import { HOURLY_BREAKDOWN } from './insights.js';

const INSIGHT_FIELDS = 'campaign_name,campaign_id,adset_id,ad_id,ad_name,spend,impressions,clicks,ctr,cpm,frequency,actions';
const HOURLY_FIELDS = 'campaign_name,campaign_id,adset_id,ad_id,ad_name,spend,impressions,clicks,actions';
const LIVE_STATUSES = ['ACTIVE', 'PAUSED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_BILLING_INFO'];

export const fetchAccount = (api, accountId) =>
  api.get(`/${accountId}`, { fields: 'timezone_name,currency,account_status,disable_reason,spend_cap,amount_spent' });

export const fetchTodayInsights = (api, accountId) =>
  api.getAll(`/${accountId}/insights`, { level: 'ad', date_preset: 'today', fields: INSIGHT_FIELDS, limit: 500 });

export const fetchAds = (api, accountId) =>
  api.getAll(`/${accountId}/ads`, {
    fields: 'name,effective_status,campaign_id,adset_id,campaign{name}',
    effective_status: LIVE_STATUSES,
    limit: 500,
  });

// Hourly rows per ad and day, in the advertiser (account) timezone.
export const fetchHourly = (api, accountId, since, until) =>
  api.getAll(`/${accountId}/insights`, {
    level: 'ad',
    breakdowns: HOURLY_BREAKDOWN,
    time_increment: 1,
    time_range: { since, until },
    fields: HOURLY_FIELDS,
    limit: 500,
  });
