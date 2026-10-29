// "Seguimiento": informational day counters. There are NO verdicts here: those only come automatically
// (test verdict on day 4, post-raise check on day 2, see decisions.js).
//  - day N since an ad (or a CT) started to spend (day 1 = first day with spend),
//  - day N since the last budget raise (day 1 = the day of the raise) with its date and percentage,
//  - for ads still in the test, when the automatic verdict will come.
import { extractCt } from './parse.js';
import { isMonitored } from './report.js';
import { addDays, daysBetween } from './time.js';

const ACTIVE_WITHIN_DAYS = 2; // an ad counts as running when it spent in the last 2 days
const RAISE_MAX_AGE_DAYS = 14;

// { adId: { date, pct, dayN, exact, entityType, entityId } } with the latest recent raise of each ad's ad set or campaign.
export function raisesByAd({ insights, changes, today, maxAgeDays = RAISE_MAX_AGE_DAYS }) {
  const recent = changes.filter((c) => daysBetween(c.date, today) >= 0 && daysBetween(c.date, today) <= maxAgeDays);
  const ownersOf = new Map();
  for (const r of insights) {
    for (const [type, id] of [['adset', r.adsetId], ['campaign', r.campaignId]]) {
      if (!id) continue;
      const key = `${type}|${id}`;
      if (!ownersOf.has(key)) ownersOf.set(key, new Set());
      ownersOf.get(key).add(r.adId);
    }
  }
  const out = {};
  for (const c of recent) {
    for (const adId of ownersOf.get(`${c.entityType}|${c.entityId}`) ?? []) {
      if (!out[adId] || c.date > out[adId].date) {
        out[adId] = { date: c.date, pct: c.pct, dayN: daysBetween(c.date, today) + 1, exact: c.exact, entityType: c.entityType, entityId: c.entityId };
      }
    }
  }
  return out;
}

export function buildTracking({ insights, ads, changes, config, today }) {
  const life = config.lifecycle;
  const lastSpend = {};
  const names = {};
  for (const r of insights) {
    if (r.gasto > 0 && (!lastSpend[r.adId] || r.date > lastSpend[r.adId])) lastSpend[r.adId] = r.date;
    names[r.adId] = r;
  }
  const raises = raisesByAd({ insights, changes, today });
  const running = Object.keys(ads).filter((adId) => {
    const first = ads[adId]?.firstSpendDate;
    const last = lastSpend[adId];
    const n = names[adId];
    return first && first <= today && last && daysBetween(last, today) <= ACTIVE_WITHIN_DAYS && n && isMonitored(n.campaignName, config.campaignPrefix);
  });

  const items = [];
  const cts = new Map();
  for (const adId of running) {
    const first = ads[adId].firstSpendDate;
    const dayN = daysBetween(first, today) + 1;
    const n = names[adId];
    items.push({
      kind: 'ad', id: adId, label: n.adName || `Anuncio ${adId}`, ct: extractCt(n.campaignName, n.adName), dayN, firstSpendDate: first,
      inTest: dayN <= life.testDays, testDays: life.testDays, verdictDay: life.testNotifyDay, verdictAt: life.testNotifyAt,
      verdictDate: addDays(first, life.testNotifyDay - 1), raise: raises[adId] ?? null,
    });
    const ct = extractCt(n.campaignName, n.adName);
    if (ct && (!cts.has(ct) || first < cts.get(ct))) cts.set(ct, first);
  }
  for (const [ct, first] of cts) {
    const dayN = daysBetween(first, today) + 1;
    items.push({
      kind: 'ct', id: ct, label: ct, ct, dayN, firstSpendDate: first, inTest: dayN <= life.testDays, testDays: life.testDays,
      verdictDay: life.testNotifyDay, verdictAt: life.testNotifyAt, verdictDate: addDays(first, life.testNotifyDay - 1), raise: null,
    });
  }
  for (const c of changes) {
    const age = daysBetween(c.date, today);
    if (age < 0 || age > RAISE_MAX_AGE_DAYS) continue;
    const field = c.entityType === 'campaign' ? 'campaignId' : 'adsetId';
    const owner = insights.filter((r) => r.adsetId === c.entityId || r.campaignId === c.entityId).filter((r) => r[field] === c.entityId).at(-1);
    if (!owner || !isMonitored(owner.campaignName, config.campaignPrefix)) continue;
    items.push({
      kind: 'budget', id: c.id, label: (c.entityType === 'campaign' ? owner.campaignName : owner.adsetName) || c.entityId, entityType: c.entityType,
      dayN: age + 1, date: c.date, pct: c.pct, exact: c.exact, checkDay: life.postBudgetNotifyDay, checkAt: life.postBudgetNotifyAt,
      checkDate: addDays(c.date, life.postBudgetNotifyDay - 1),
    });
  }
  const order = { budget: 0, ct: 1, ad: 2 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || a.dayN - b.dayN || String(a.label).localeCompare(String(b.label)));
  return { today, items };
}
