// Baseline from the last N full days of hourly data, plus the adaptive gap thresholds and the
// periodic threshold recommendations. Pure: rows in, numbers out.
//
// Row shape: { date, hour, adId, adName, spend, impressions, clicks, purchases, conversations }
import { inHourRange } from './time.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
const ratio = (a, b) => (b > 0 ? a / b : null);

function aggregate(rows) {
  const spend = sum(rows, (r) => r.spend);
  const purchases = sum(rows, (r) => r.purchases);
  const conversations = sum(rows, (r) => r.conversations);
  const impressions = sum(rows, (r) => r.impressions);
  const clicks = sum(rows, (r) => r.clicks);
  return {
    spend,
    purchases,
    conversations,
    impressions,
    cpa: ratio(spend, purchases),
    costPerConversation: ratio(spend, conversations),
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
  };
}

export function computeBaseline(rows) {
  const days = new Set(rows.map((r) => r.date)).size;

  const salesPerHour = HOURS.map((h) => (days ? sum(rows.filter((r) => r.hour === h), (r) => r.purchases) / days : 0));
  // "Hour band": each hour averaged with its two neighbours, so one quiet hour does not look like silence.
  const bandSalesPerHour = HOURS.map((h) => (salesPerHour[(h + 23) % 24] + salesPerHour[h] + salesPerHour[(h + 1) % 24]) / 3);

  const all = aggregate(rows);
  const byAd = {};
  for (const adId of new Set(rows.map((r) => r.adId))) {
    const adRows = rows.filter((r) => r.adId === adId);
    byAd[adId] = { name: adRows[0].adName, ...aggregate(adRows) };
  }

  return {
    days,
    account: {
      salesPerHour,
      bandSalesPerHour,
      salesPerDay: days ? all.purchases / days : 0,
      spendPerDay: days ? all.spend / days : 0,
      cpa: all.cpa,
      costPerConversation: all.costPerConversation,
    },
    ads: byAd,
  };
}

// Adaptive "no sale in the whole account" thresholds for an hour of the day.
//   expectedGap = 60 / (sales per hour expected in this hour band)      [minutes]
//   action      = clamp(expectedGap,        floorAction, maxGap)
//   worry       = clamp(0.75 * expectedGap, floorWorry,  action)
// With >= 1 expected sale/hour this collapses to the configured floors (45 / 60 min); with fewer it
// widens proportionally up to maxGap (default 3 h). Without baseline data it uses the floors.
export function adaptiveGaps(baseline, hour, config) {
  const { gapWorryMin, gapActionMin, maxGapMin } = config.thresholds;
  if (!baseline || !baseline.days) {
    return { worryMin: gapWorryMin, actionMin: gapActionMin, expectedGapMin: null };
  }
  const rate = baseline.account.bandSalesPerHour[hour];
  const expectedGapMin = rate > 0 ? 60 / rate : maxGapMin;
  const actionMin = Math.max(gapActionMin, Math.min(expectedGapMin, maxGapMin));
  const worryMin = Math.min(Math.max(gapWorryMin, 0.75 * expectedGapMin), actionMin);
  return { worryMin: Math.round(worryMin), actionMin: Math.round(actionMin), expectedGapMin: Math.round(expectedGapMin) };
}

const roundTo = (value, step) => Math.round(value / step) * step;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const MIN_DAYS_FOR_RECOMMENDATION = 3;

// Recommended thresholds from the baseline. Only values that differ meaningfully from the current
// ones are returned; nothing is applied here.
export function recommendThresholds(baseline, config) {
  if (!baseline || baseline.days < MIN_DAYS_FOR_RECOMMENDATION) return [];
  const t = config.thresholds;
  const recs = [];
  const push = (name, current, recommended, reason, significant) => {
    if (significant(current, recommended)) recs.push({ name, current, recommended, reason });
  };
  const rel10 = (a, b) => Math.abs(a - b) / a >= 0.1;

  const cpa = baseline.account.cpa;
  if (cpa) {
    const target = roundTo(cpa * 1.1, 100);
    const review = roundTo(target * (t.reviewCpa / t.targetCpa), 100);
    push('targetCpa', t.targetCpa, target, `average CPA of the last ${baseline.days} days is ${Math.round(cpa)}`, rel10);
    push('reviewCpa', t.reviewCpa, review, 'keeps the same review/target ratio', rel10);
  }

  const activeHours = HOURS.filter((h) => inHourRange(h, config.activeHours));
  if (activeHours.length > 0) {
    const rate = sum(activeHours, (h) => baseline.account.salesPerHour[h]) / activeHours.length;
    const gap = rate > 0 ? 60 / rate : t.maxGapMin;
    const action = clamp(roundTo(gap, 5), 30, t.maxGapMin);
    const worry = Math.min(clamp(roundTo(0.75 * gap, 5), 15, t.maxGapMin), action - 5);
    const far = (a, b) => Math.abs(a - b) >= 10;
    push('gapWorryMin', t.gapWorryMin, worry, `about ${rate.toFixed(1)} sales per active hour`, far);
    push('gapActionMin', t.gapActionMin, action, `about ${rate.toFixed(1)} sales per active hour`, far);
  }
  return recs;
}
