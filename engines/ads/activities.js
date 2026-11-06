// Account activity log -> budget events. Used by the budget snapshot (recent window) and by the one-time history
// backfill (since the start of the history). Read-only.
import { parseActivity } from './budget.js';
import { friendlyMetaError } from './meta-api.js';
import { fetchActivities } from './meta-data.js';
import { redact } from './redact.js';

// { ok, count, events } or { ok: false, error }. Failures are not fatal: snapshots are the fallback.
export async function syncActivities({ api, store, config, since, timezone, token, accountId = config.adAccountId }) {
  try {
    const rows = await fetchActivities(api, accountId, since);
    const events = rows.map((a) => parseActivity(a, timezone)).filter(Boolean);
    store.upsertBudgetEvents(events, accountId);
    store.setKv('activitiesOk', true);
    return { ok: true, count: rows.length, events: events.length };
  } catch (error) {
    store.setKv('activitiesOk', false);
    return { ok: false, error: redact(friendlyMetaError(error), token) };
  }
}

// Diagnostics for the real response shape: counts per event type and the keys/value kinds of budget events.
// No names and no actors are returned.
export async function probeActivities({ api, config, since, accountId = config.adAccountId }) {
  const rows = await fetchActivities(api, accountId, since);
  const byType = {};
  const budgetShapes = {};
  let sample = null;
  for (const a of rows) {
    byType[a.event_type] = (byType[a.event_type] ?? 0) + 1;
    if (/budget/i.test(a.event_type)) {
      let extra = a.extra_data;
      const wasString = typeof extra === 'string';
      if (wasString) {
        try {
          extra = JSON.parse(extra);
        } catch {
          extra = null;
        }
      }
      const shape = `${a.event_type}|extra:${wasString ? 'json-string' : typeof a.extra_data}|keys:${Object.keys(extra ?? {}).sort().join(',')}`;
      budgetShapes[shape] = (budgetShapes[shape] ?? 0) + 1;
      sample ??= { event_type: a.event_type, object_type: a.object_type, event_time: a.event_time, extra_data_kinds: Object.fromEntries(Object.entries(extra ?? {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])) };
    }
  }
  return { total: rows.length, fields: Object.keys(rows[0] ?? {}), byType, budgetShapes, sample };
}
