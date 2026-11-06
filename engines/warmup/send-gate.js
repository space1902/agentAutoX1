// Runtime side of the activity window and the daily cap for ONE session (a tester or the bot).
// The pure rules live in activity-schedule.js; this keeps today's send count.
//
// The count is rebuilt from the session's activity log (activity-<session>.jsonl, written by wa-client.js
// for every message the session sends), filtered by the LOCAL calendar day of the session's time zone.
// A restart therefore never resets the cap, and the UTC date of the log timestamps does not matter.
import { DAY_MS, addDays, dateKeyFor, evaluateGate, spreadDelayMs, zonedWallToUtcMs } from './activity-schedule.js';
import { readActivity } from './wa-activity.js';

// Messages this session sent on `dateKey` (local day in `timezone`). Never throws.
export function countSentOnDay({ resultsDir, session, dateKey, timezone, read = readActivity }) {
  try {
    const startMs = zonedWallToUtcMs(dateKey, 0, timezone);
    const endMs = zonedWallToUtcMs(addDays(dateKey, 1), 0, timezone);
    // Start one day early in seconds only to bound the read; the exact day is applied below.
    const { messages } = read(resultsDir, session, Math.floor((startMs - DAY_MS) / 1000));
    return messages.filter((m) => m.fromMe && m.timestamp * 1000 >= startMs && m.timestamp * 1000 < endMs).length;
  } catch {
    return 0;
  }
}

// getAge: () => { days, incidents } | null, read on every check so a new health analysis is picked up.
// flatCap: a fixed daily cap that ignores age (the bot).
export function createSendGate({
  sessionId,
  schedule,
  timezone,
  resultsDir,
  getAge = () => null,
  flatCap = null,
  now = Date.now,
  read = readActivity,
}) {
  let day = { key: null, count: 0 };
  let last = null;

  return {
    // The gate for this instant: { state: 'active' | 'outside_window' | 'capped', count, cap, window, nextOpenMs, ... }
    check() {
      const at = now();
      const key = dateKeyFor(at, timezone);
      if (day.key !== key) day = { key, count: countSentOnDay({ resultsDir, session: sessionId, dateKey: key, timezone, read }) };

      const age = getAge() ?? {};
      last = {
        ...evaluateGate({
          sessionId,
          now: at,
          count: day.count,
          days: age.days,
          incidents: age.incidents ?? 0,
          flatCap,
          schedule,
          timezone,
        }),
        at,
      };
      return last;
    },

    // Call after a message was really sent.
    recordSent() {
      const key = dateKeyFor(now(), timezone);
      if (day.key !== key) day = { key, count: countSentOnDay({ resultsDir, session: sessionId, dateKey: key, timezone, read }) };
      day.count += 1;
    },

    // Extra wait that spreads the rest of today's cap over the rest of today's window.
    spreadDelayMs(random = Math.random) {
      const status = this.check();
      if (!status.enabled || !status.window) return 0;
      return spreadDelayMs({ now: status.at, windowEndMs: status.window.endMs, cap: status.cap, count: status.count, random });
    },
  };
}
