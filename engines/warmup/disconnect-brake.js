// Disconnect brake: pure counting rules, no I/O and no timers (lib.js owns the clock and the pausing).
//
// A number that keeps dropping its connection is a risk signal, so after BRAKE.threshold disconnects
// within BRAKE.windowMs it is paused (the pause length lives in pause-state.js: 6 h, doubling, max 48 h).
//
// This PC crashes and loses the network, and that must never pause the fleet:
//   - LOCAL EVENT: when at least BRAKE.localEventFraction of the sessions (and at least
//     BRAKE.minLocalSessions) disconnect inside one BRAKE.localEventWindowMs window, those disconnects are
//     a problem of this machine or its network and count toward NO number's threshold.
//   - A decision waits BRAKE.settleMs after a number's latest disconnect, so the rest of a fleet-wide drop
//     has time to arrive before anyone is judged.
//   - Disconnects within BRAKE.startupGraceMs of a session start (reconnects after a restart) and events the
//     caller flags as exempt (the process was suspended) are ignored.
// WhatsApp's own "restart required" close (515) is not even reported as a disconnect by wa-client.js.

const MIN_MS = 60_000;

export const BRAKE = Object.freeze({
  threshold: 5,
  windowMs: 60 * MIN_MS,
  localEventFraction: 0.6,
  localEventWindowMs: 2 * MIN_MS,
  minLocalSessions: 2,
  settleMs: 2 * MIN_MS,
  startupGraceMs: 2 * MIN_MS,
});

// event: { session, at, fleet }. True when `event` belongs to a window of localEventWindowMs in which
// enough different sessions dropped together.
export function isLocalEvent(event, events, config = BRAKE) {
  const span = config.localEventWindowMs;
  for (const start of events) {
    if (start.at > event.at || event.at - start.at > span) continue;
    const inWindow = events.filter((e) => e.at >= start.at && e.at <= start.at + span);
    const sessions = new Set(inWindow.map((e) => e.session));
    const fleet = Math.max(...inWindow.map((e) => e.fleet ?? 0));
    // The epsilon keeps 0.6 * 10 from rounding up to 7.
    const needed = Math.max(config.minLocalSessions, Math.ceil(config.localEventFraction * fleet - 1e-9));
    if (sessions.size >= needed) return true;
  }
  return false;
}

export function createDisconnectTracker(config = BRAKE) {
  let events = [];
  const started = new Map();
  let newest = 0;

  // Everything needed to judge an event is within threshold window + cluster window of it.
  const keepMs = config.windowMs + 2 * config.localEventWindowMs + config.settleMs;

  const counted = (session, now) => {
    const from = now - config.windowMs;
    return events.filter(
      (e) => e.session === session && !e.exempt && e.at > from && e.at <= now && !isLocalEvent(e, events, config),
    );
  };

  return {
    // Call when a session's first connection opens (or it is revived), to start its grace period.
    markStarted(session, at) {
      started.set(session, at);
    },

    record({ session, at, fleetSize = 0, exempt = false }) {
      const startedAt = started.get(session);
      const inGrace = startedAt !== undefined && at >= startedAt && at - startedAt < config.startupGraceMs;
      events.push({ session, at, fleet: fleetSize, exempt: Boolean(exempt) || inGrace });
      newest = Math.max(newest, at);
      if (events.length > 64) events = events.filter((e) => newest - e.at <= keepMs);
    },

    count(session, now) {
      return counted(session, now).length;
    },

    // Sessions over the threshold whose latest disconnect is old enough to judge.
    evaluate(now) {
      const result = [];
      for (const session of new Set(events.map((e) => e.session))) {
        const own = events.filter((e) => e.session === session && !e.exempt);
        const latest = own.reduce((max, e) => Math.max(max, e.at), -Infinity);
        if (own.length === 0 || now - latest < config.settleMs) continue;
        const count = counted(session, now).length;
        if (count >= config.threshold) {
          result.push({
            session,
            count,
            detail: `${count} disconnects in ${Math.round(config.windowMs / MIN_MS)} min`,
          });
        }
      }
      return result;
    },

    clear(session) {
      events = events.filter((e) => e.session !== session);
    },

    size: () => events.length,
  };
}
