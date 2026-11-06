// One source of truth for "how old is this number and has it had real incidents", used by the engine
// (daily cap) and by the app's schedule-status, so both always show the same cap. Pure.
//
// Incidents here are ONLY real per-number events: a LOGOUT, or a pause from the disconnect brake. Raw
// disconnects and QR events are NOT counted: a PC freeze or network drop produces them for every number
// at once and must not lower anyone's daily cap. (The hourly pace and the health score keep using
// summarizeIncidents; they are unchanged.)
import { daysSince } from './health-metrics.js';

export const AGE_WINDOW_DAYS = 14;

export function capIncidents(events, session, sinceMs) {
  let count = 0;
  for (const e of events) {
    if (e.session !== session) continue;
    const ms = new Date(e.at).getTime();
    if (Number.isNaN(ms) || ms < sinceMs) continue;
    if (e.event === 'disconnected' && String(e.detail) === 'LOGOUT') count++;
    else if (e.event === 'paused' && String(e.detail ?? '').startsWith('repeated_disconnects')) count++;
  }
  return count;
}

// earliestSentSeconds: first message the session ever sent (activity log), or null.
export function sessionAge({ session, events, earliestSentSeconds, now = new Date(), windowDays = AGE_WINDOW_DAYS }) {
  let first = Infinity;
  for (const e of events) {
    if (e.session !== session || e.event !== 'ready') continue;
    const ms = new Date(e.at).getTime();
    if (!Number.isNaN(ms) && ms < first) first = ms;
  }
  if (Number.isFinite(earliestSentSeconds)) first = Math.min(first, earliestSentSeconds * 1000);

  const days = Number.isFinite(first) ? Math.max(1, daysSince(new Date(first).toISOString(), now)) : 1;
  return { days, incidents: capIncidents(events, session, now.getTime() - windowDays * 86_400_000) };
}
