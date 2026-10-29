// Budget increase detection. Pure.
//  - From snapshots (budget_history): a raise is seen when the daily budget differs from the previous snapshot. The
//    date is the day the new value was first seen, so a change made while the app was closed is dated at the next
//    sync (best effort).
//  - From the account activity log (update_ad_set_budget / update_campaign_budget) when Meta exposes it: exact time.
import { localParts } from './time.js';

const TYPES = { update_ad_set_budget: 'adset', update_campaign_budget: 'campaign' };

const pctOf = (from, to) => ((to - from) / from) * 100;

// Rows of ONE entity in chronological order.
export function detectIncreases(history) {
  const out = [];
  let last = null;
  for (const row of history) {
    if (row.dailyBudget == null) continue;
    if (last != null && row.dailyBudget > last) {
      out.push({ date: row.date, oldBudget: last, newBudget: row.dailyBudget, pct: pctOf(last, row.dailyBudget), firstSeen: row.firstSeen });
    }
    last = row.dailyBudget;
  }
  return out;
}

const budgetValue = (v) => {
  const raw = v && typeof v === 'object' ? (v.daily_budget ?? v.budget ?? v.value) : v;
  const n = Number(raw);
  return raw == null || raw === '' || !Number.isFinite(n) ? null : n;
};

// One /activities row -> { entityType, entityId, time, date, oldBudget, newBudget } or null.
export function parseActivity(activity, timezone) {
  const entityType = TYPES[activity?.event_type];
  if (!entityType || !activity.object_id) return null;
  let extra = activity.extra_data;
  if (typeof extra === 'string') {
    try {
      extra = JSON.parse(extra);
    } catch {
      return null;
    }
  }
  const oldBudget = budgetValue(extra?.old_value);
  const newBudget = budgetValue(extra?.new_value);
  const time = Date.parse(activity.event_time);
  if (oldBudget == null || newBudget == null || !Number.isFinite(time)) return null;
  return { entityType, entityId: String(activity.object_id), time, date: localParts(time, timezone).date, oldBudget, newBudget };
}

// histories: { "adset|s1": [rows...] }, events: parsed activities. Returns the raises sorted by date.
export function computeChanges({ histories = {}, events = [] }) {
  const changes = [];
  for (const e of events) {
    if (e.newBudget > e.oldBudget) {
      changes.push({ entityType: e.entityType, entityId: e.entityId, date: e.date, oldBudget: e.oldBudget, newBudget: e.newBudget, pct: pctOf(e.oldBudget, e.newBudget), exact: true, time: e.time });
    }
  }
  for (const [key, rows] of Object.entries(histories)) {
    const [entityType, entityId] = key.split('|');
    for (const c of detectIncreases(rows)) {
      // The activity log already knows this raise (any direction counts as "covered"): keep the exact one only.
      const covered = events.some((e) => e.entityType === entityType && e.entityId === entityId && e.newBudget === c.newBudget);
      if (!covered) changes.push({ entityType, entityId, date: c.date, oldBudget: c.oldBudget, newBudget: c.newBudget, pct: c.pct, exact: false, time: null });
    }
  }
  changes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastOf = new Map();
  return changes.map((c) => {
    const entity = `${c.entityType}:${c.entityId}`;
    const previous = lastOf.get(entity) ?? null;
    lastOf.set(entity, { date: c.date, pct: c.pct });
    return { id: `${entity}:${c.date}:${c.newBudget}`, ...c, previous };
  });
}
