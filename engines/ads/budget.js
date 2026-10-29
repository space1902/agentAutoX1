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

// Meta nests the amount: extra_data is a JSON string whose new_value / old_value are themselves JSON strings like
// {"type":"payment_amount","currency":"COP","new_value":13000,"additional_value":"Diario"}. Plain numbers and
// {daily_budget} objects are accepted too. Amounts are whole currency units (COP has no minor unit), the same unit
// the Graph API returns for daily_budget.
const AMOUNT_KEYS = ['new_value', 'old_value', 'daily_budget', 'budget', 'value', 'amount'];
const budgetValue = (v, depth = 0) => {
  if (v == null || depth > 3) return null;
  if (typeof v === 'string') {
    const text = v.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return budgetValue(JSON.parse(text), depth + 1);
      } catch {
        return null;
      }
    }
    const n = Number(text);
    return text !== '' && Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') {
    for (const key of AMOUNT_KEYS) if (v[key] !== undefined) return budgetValue(v[key], depth + 1);
  }
  return null;
};

// Lifetime budgets are described as "Total"/"Vitalicio" in additional_value; only daily budgets matter here.
const isDailyBudget = (extra) => {
  const kind = String(budgetKind(extra?.new_value) ?? budgetKind(extra?.old_value) ?? '').toLowerCase();
  return !kind || /diario|daily/.test(kind);
};
function budgetKind(v) {
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return JSON.parse(v).additional_value;
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' ? v.additional_value : null;
}

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
  if (!isDailyBudget(extra)) return null;
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
