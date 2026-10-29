// Alert rules. Pure functions: (snapshot + baseline + config) -> alerts. No I/O, no clock reads.
//
// snapshot = {
//   account: { status, disableReason, spendCap, amountSpent },
//   ads: [{ id, name, campaignId, campaignName, adsetId, status, spend, impressions, clicks,
//           frequency, purchases, conversations }],            // cumulative values for "today"
//   sales: { accountLastTs, ads: { [adId]: { ts, spendAt } } }, // today's last sale events
//   windows: { spend2h: { [adId]: delta } | null, conversations3h: n | null, purchases3h: n | null },
// }
//
// Alert = { family, severity (1 | 2), level ('worry' | 'action' | 'critical'), type, ...details, actions? }
// `family` is the de-duplication key: the same family is not resent inside the cooldown, and a higher
// severity in the same family replaces (escalates) a lower one.
import { adaptiveGaps } from './baseline.js';
import { inHourRange, localParts } from './time.js';

export function cpaColor(cpa, t) {
  if (cpa == null) return 'none';
  if (cpa <= t.targetCpa) return 'green';
  if (cpa <= t.reviewCpa) return 'yellow';
  return 'red';
}

// Click-to-WhatsApp ads cannot be paused on their own node (Meta error 2446880), so the pause
// targets the ad set that contains the ad. `adId`/`label` keep the ad recognizable for the user.
const pauseAction = (ad) => ({ kind: 'pause_adset', targetId: ad.adsetId, adId: ad.id, label: ad.name });
const BAD_AD_STATUSES = new Set(['DISAPPROVED', 'WITH_ISSUES']);

export function evaluate({ now, tz, config, baseline, snapshot }) {
  const t = config.thresholds;
  const local = localParts(now, tz);
  const inActiveHours = inHourRange(local.hour, config.activeHours);
  const activeAds = snapshot.ads.filter((a) => a.status === 'ACTIVE');
  const alerts = [];

  const spentSinceSale = (ad) => ad.spend - (snapshot.sales.ads[ad.id]?.spendAt ?? 0);

  // 1. Per ad: spend without a sale since its last sale today.
  for (const ad of activeAds) {
    const spent = spentSinceSale(ad);
    if (spent < t.targetCpa) continue;
    const base = {
      type: 'ad_no_sale', adId: ad.id, adName: ad.name, spentSinceSale: spent,
      thresholds: { target: t.targetCpa, review: t.reviewCpa },
      family: `ad:${ad.id}:nosale:${snapshot.sales.ads[ad.id]?.ts ?? 0}`,
    };
    alerts.push(
      spent >= t.reviewCpa
        ? { ...base, level: 'action', severity: 2, actions: [pauseAction(ad)] }
        : { ...base, level: 'worry', severity: 1 },
    );
  }

  // 2. Account-wide gap since the last sale (counted from the start of active hours at the earliest).
  if (inActiveHours && activeAds.length > 0) {
    const sinceActiveStart = (local.minutesOfDay - config.activeHours.start * 60 + 1440) % 1440;
    const { accountLastTs } = snapshot.sales;
    const sinceSale = accountLastTs != null ? (now - accountLastTs) / 60_000 : Infinity;
    const gap = Math.min(sinceSale, sinceActiveStart);
    const { worryMin, actionMin } = adaptiveGaps(baseline, local.hour, config);
    const family = `account:gap:${accountLastTs ?? local.date}`;
    if (gap >= actionMin) {
      const suggested = activeAds
        .filter((a) => spentSinceSale(a) >= t.targetCpa)
        .sort((a, b) => spentSinceSale(b) - spentSinceSale(a))
        .slice(0, 2);
      alerts.push({
        type: 'account_gap', level: 'action', severity: 2, family, minutes: Math.round(gap),
        thresholdMin: actionMin, actions: suggested.map(pauseAction),
      });
    } else if (gap >= worryMin) {
      alerts.push({ type: 'account_gap', level: 'worry', severity: 1, family, minutes: Math.round(gap), thresholdMin: worryMin });
    }
  }

  // 4. Immediate alerts.
  for (const ad of snapshot.ads) {
    if (BAD_AD_STATUSES.has(ad.status)) {
      alerts.push({ type: 'ad_status', level: 'critical', severity: 2, family: `ad:${ad.id}:status:${ad.status}`, adId: ad.id, adName: ad.name, status: ad.status });
    }
  }

  const { account } = snapshot;
  if (account.status !== 1) {
    alerts.push({ type: 'account_status', level: 'critical', severity: 2, family: `account:status:${account.status}`, status: account.status, disableReason: account.disableReason });
  }
  if (Number(account.spendCap) > 0 && Number(account.amountSpent) >= Number(account.spendCap)) {
    alerts.push({ type: 'spend_cap', level: 'critical', severity: 2, family: 'account:spendcap', spendCap: Number(account.spendCap), amountSpent: Number(account.amountSpent) });
  }

  if (inActiveHours && snapshot.windows?.spend2h) {
    for (const ad of activeAds) {
      if (snapshot.windows.spend2h[ad.id] === 0) {
        alerts.push({ type: 'ad_no_spend', level: 'worry', severity: 1, family: `ad:${ad.id}:nospend`, adId: ad.id, adName: ad.name, hours: t.noSpendHours });
      }
    }
  }

  const { conversations3h, purchases3h } = snapshot.windows ?? {};
  if (inActiveHours && conversations3h != null && purchases3h === 0 && conversations3h >= t.minConversationsNoPurchase) {
    alerts.push({ type: 'pixel_suspect', level: 'critical', severity: 2, family: 'account:pixel', conversations: conversations3h, hours: t.noPurchaseHours });
  }

  for (const ad of activeAds) {
    const base = baseline?.ads?.[ad.id];
    const family = (name) => `ad:${ad.id}:${name}`;
    const named = { adId: ad.id, adName: ad.name };

    if (base?.costPerConversation && ad.conversations >= t.minConversationsForCost) {
      const current = ad.spend / ad.conversations;
      if (current > base.costPerConversation * t.costPerConversationMult) {
        alerts.push({ type: 'cost_per_conversation', level: 'worry', severity: 1, family: family('costconv'), ...named, current, baseline: base.costPerConversation });
      }
    }

    if (ad.frequency > t.frequencyMax && ad.impressions >= t.minImpressions) {
      alerts.push({ type: 'frequency', level: 'worry', severity: 1, family: family('freq'), ...named, frequency: ad.frequency, limit: t.frequencyMax });
    }

    if (ad.impressions >= t.minImpressions) {
      const ctr = (ad.clicks / ad.impressions) * 100;
      const cpm = (ad.spend / ad.impressions) * 1000;
      if (base?.ctr && ctr < base.ctr * t.ctrMinRatio) {
        alerts.push({ type: 'ctr_drop', level: 'worry', severity: 1, family: family('ctr'), ...named, current: ctr, baseline: base.ctr });
      }
      if (base?.cpm && cpm > base.cpm * t.cpmMaxRatio) {
        alerts.push({ type: 'cpm_rise', level: 'worry', severity: 1, family: family('cpm'), ...named, current: cpm, baseline: base.cpm });
      }
    }
  }

  return alerts;
}

// De-duplication: lastByFamily = { family: { ts, severity } } of alerts actually SENT.
export function filterAlerts(alerts, lastByFamily, now, cooldownMin) {
  return alerts.filter((alert) => {
    const last = lastByFamily[alert.family];
    if (!last) return true;
    if (alert.severity > last.severity) return true;
    return now - last.ts >= cooldownMin * 60_000;
  });
}

export function shouldSendSummary({ now, tz, config, lastKey }) {
  const local = localParts(now, tz);
  const key = `${local.date}T${String(local.hour).padStart(2, '0')}`;
  return { send: inHourRange(local.hour, config.activeHours) && key !== lastKey, key };
}

export function buildSummary({ config, ads }) {
  const t = config.thresholds;
  const colorFor = (spend, cpa) => {
    if (cpa != null) return cpaColor(cpa, t);
    if (spend > t.reviewCpa) return 'red';
    if (spend > t.targetCpa) return 'yellow';
    return 'none';
  };
  const rows = ads
    .filter((a) => a.spend > 0 || a.purchases > 0)
    .map((a) => {
      const cpa = a.purchases > 0 ? a.spend / a.purchases : null;
      return { adId: a.id, adName: a.name, spend: a.spend, purchases: a.purchases, cpa, color: colorFor(a.spend, cpa) };
    })
    .sort((a, b) => b.spend - a.spend);
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const purchases = rows.reduce((s, r) => s + r.purchases, 0);
  const cpa = purchases > 0 ? spend / purchases : null;
  return { rows, totals: { spend, purchases, cpa, color: colorFor(spend, cpa) } };
}
