// Decides when a number is paused or resumed and carries it out: pause store + events.jsonl + closing
// the socket. Everything with a side effect is injected, so the rules are tested with fakes and no real
// timers. lib.js builds the real instance.
//
// - Logout (401): the number is paused until a human resumes it. Nothing is archived, deleted or linked
//   again automatically; the saved session stays exactly as WhatsApp left it.
// - Disconnects: counted by disconnect-brake.js (which ignores machine-wide events) and judged only after
//   a settle delay; the brake pause is timed (pause-state.js).
// - Events logged: 'paused' and 'resumed'. health-metrics counts only qr / disconnected / auth_failure,
//   so these never add to the incident totals.
import { BRAKE } from './disconnect-brake.js';

// A gap between heartbeats longer than this means the whole process was frozen (PC sleep or crash
// recovery): the disconnects reported right after are a local event, not the number's fault.
export const SUSPEND_GAP_MS = 45_000;

export function createSupervisor({
  store,
  tracker,
  now = Date.now,
  fleetSize = () => 0,
  logEvent = () => {},
  stopSession = () => {},
  numberOf = () => null,
  warn = console.warn,
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
} = {}) {
  let lastBeat = null;

  const describe = (entry, source) => {
    const parts = [entry.reason];
    if (entry.detail) parts.push(entry.detail);
    parts.push(`source=${source}`);
    if (entry.until) parts.push(`until ${entry.until}`);
    return parts.join('; ');
  };

  const supervisor = {
    // Heartbeat, called every few seconds while the process is alive.
    beat() {
      lastBeat = now();
    },

    markStarted(session) {
      tracker.markStarted(session, now());
    },

    // durationMs null = until a human resumes. Returns the pause entry; an existing pause is kept.
    pauseSession(session, { reason, source, durationMs = null, detail = null, countStrike = false }) {
      const existing = store.get(session);
      if (existing) return existing;

      const entry = store.pause({ session, number: numberOf(session), reason, source, durationMs, detail, countStrike });
      tracker.clear(session);
      logEvent(session, 'paused', describe(entry, source));
      try {
        stopSession(session);
      } catch (error) {
        warn(`[pause] could not close the session of ${session}: ${error?.message || error}`);
      }
      return entry;
    },

    resumeSession(session, source = 'user') {
      const was = store.resume(session);
      if (was) {
        tracker.clear(session);
        logEvent(session, 'resumed', `source=${source}`);
      }
      return was;
    },

    // WhatsApp ended the session (401): pause it until a human resumes it. Never relinks or archives.
    onLoggedOut(session) {
      return supervisor.pauseSession(session, { reason: 'logged_out', source: 'engine', durationMs: null, detail: 'WhatsApp logged the session out (401)' });
    },

    // A reconnectable close (timeouts, 503, ...). Judged later by sweep().
    onDisconnect(session) {
      const at = now();
      const suspended = lastBeat !== null && at - lastBeat > SUSPEND_GAP_MS;
      tracker.record({ session, at, fleetSize: fleetSize(), exempt: suspended });
      setTimer(() => supervisor.sweep(), BRAKE.settleMs + 1000);
    },

    // Ends finished timed pauses and applies the brake to numbers over the threshold.
    sweep() {
      try {
        for (const session of store.expire()) {
          tracker.clear(session);
          logEvent(session, 'resumed', 'expired');
        }

        for (const hit of tracker.evaluate(now())) {
          if (store.get(hit.session)) {
            tracker.clear(hit.session);
            continue;
          }
          const { durationMs } = store.brakeDuration(hit.session);
          supervisor.pauseSession(hit.session, {
            reason: 'repeated_disconnects',
            source: 'engine',
            durationMs,
            detail: hit.detail,
            countStrike: true,
          });
        }
      } catch (error) {
        warn(`[pause] sweep failed: ${error?.message || error}`);
      }
    },

    isPaused: (session) => Boolean(store.get(session)),
  };

  return supervisor;
}
