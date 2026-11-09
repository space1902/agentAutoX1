// Sales signal from the payments sheet (the real source of truth), shaped for the alerts monitor.
// A sale is a valid payment (or one accepted by hand in the app: `accepted`) of the configured flow; its moment is "Registrado el" (when it arrived), not the
// voucher date. Pure functions over the rows returned by ../sheet.js.
import { parseDateToIso } from '../parse.js';
import { isValidResult, matchesFlow } from '../sheet.js';

// Payments with no ad id are still sales for the account-wide "minutes without sales" rule.
export const UNATTRIBUTED = '__unattributed__';

// "28/10/2026 10:05:00" -> { date: '2026-10-28', hour: 10, minutes: 605 }; hour/minutes null when there is no time.
export function registeredParts(text) {
  const date = parseDateToIso(text);
  if (!date) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(String(text));
  if (!time) return { date, hour: null, minutes: null };
  const hour = Number(time[1]);
  return { date, hour, minutes: hour * 60 + Number(time[2]) };
}

function validSales(rows, { flowPrefix, validResult }) {
  const out = [];
  for (const r of rows) {
    if (r.rejected || !(r.accepted || isValidResult(r.result, validResult)) || !matchesFlow(r.flow, flowPrefix)) continue;
    const when = registeredParts(r.registered);
    if (when) out.push({ ...when, adId: r.adId || UNATTRIBUTED });
  }
  return out;
}

// { byAd: {adId: n}, unattributed: n, total, lastMinutes } for payments registered on `today`.
export function todaySales(rows, { today, flowPrefix, validResult }) {
  const byAd = {};
  let unattributed = 0;
  let total = 0;
  let lastMinutes = null;
  for (const s of validSales(rows, { flowPrefix, validResult })) {
    if (s.date !== today) continue;
    total++;
    if (s.adId === UNATTRIBUTED) unattributed++;
    else byAd[s.adId] = (byAd[s.adId] ?? 0) + 1;
    if (s.minutes !== null && (lastMinutes === null || s.minutes > lastMinutes)) lastMinutes = s.minutes;
  }
  return { byAd, unattributed, total, lastMinutes };
}

// Map "date|hour|adId" -> count for payments registered between from and to.
export function hourlySales(rows, { from, to, flowPrefix, validResult }) {
  const out = new Map();
  for (const s of validSales(rows, { flowPrefix, validResult })) {
    if (s.hour === null || s.date < from || s.date > to) continue;
    const key = `${s.date}|${s.hour}|${s.adId}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

// Hourly Meta rows with their `purchases` replaced (source "sheet") or raised to the larger value ("both") by the
// sheet. Hours where the sheet has payments but Meta has no row get a synthetic row, so no sale is lost.
export function mergeHourlyPurchases(metaRows, sheetCounts, source) {
  if (source === 'meta') return metaRows;
  const remaining = new Map(sheetCounts);
  const rows = metaRows.map((r) => {
    const key = `${r.date}|${r.hour}|${r.adId}`;
    const fromSheet = remaining.get(key) ?? 0;
    remaining.delete(key);
    return { ...r, purchases: source === 'both' ? Math.max(r.purchases, fromSheet) : fromSheet };
  });
  for (const [key, count] of remaining) {
    const [date, hour, adId] = key.split('|');
    rows.push({ date, hour: Number(hour), adId, adName: adId === UNATTRIBUTED ? 'Sin anuncio' : `Anuncio ${adId}`, spend: 0, impressions: 0, clicks: 0, purchases: count, conversations: 0 });
  }
  return rows;
}
