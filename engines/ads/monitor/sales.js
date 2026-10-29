// Sale detection. The API only gives cumulative purchases for the day, so a "sale event" is the
// difference between two polls. Pure functions; persistence lives in store.js.
import { localParts } from './time.js';

// prev: { adId: cumulativePurchases } from the previous poll of the same day, or null when unknown
// (unknown history never produces events: we cannot tell when those sales happened).
export function detectSales(prev, ads, nowMs) {
  if (!prev) return [];
  const events = [];
  for (const ad of ads) {
    const before = prev[ad.id] ?? 0;
    if (ad.purchases > before) {
      events.push({ adId: ad.id, count: ad.purchases - before, spendAt: ad.spend, ts: nowMs });
    }
  }
  return events;
}

// Rebuilds one approximate "last sale" per ad from today's hourly rows (used right after a start,
// when we have no polls yet). The sale is placed at the end of the last hour with purchases.
export function seedSalesFromHourly(rows, { nowMs, tz }) {
  const now = localParts(nowMs, tz);
  const byAd = new Map();
  for (const row of rows) {
    if (row.date !== now.date || row.hour == null) continue;
    if (!byAd.has(row.adId)) byAd.set(row.adId, []);
    byAd.get(row.adId).push(row);
  }

  const events = [];
  for (const [adId, adRows] of byAd) {
    const withSales = adRows.filter((r) => r.purchases > 0);
    if (withSales.length === 0) continue;
    const lastHour = Math.max(...withSales.map((r) => r.hour));
    const hourEnd = lastHour * 60 + 59;
    const ts = Math.min(nowMs, nowMs - (now.minutesOfDay - hourEnd) * 60_000);
    events.push({
      adId,
      count: withSales.reduce((sum, r) => sum + r.purchases, 0),
      spendAt: adRows.filter((r) => r.hour <= lastHour).reduce((sum, r) => sum + r.spend, 0),
      ts,
    });
  }
  return events;
}
