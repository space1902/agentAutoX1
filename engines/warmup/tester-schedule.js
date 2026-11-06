// Pure scheduling helpers for the per-tester loops in tester.js.
// No I/O and no timers here, so everything is unit-testable.

const HOUR_MS = 60 * 60 * 1000;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeDelay(delay, fallback) {
  let min = Math.max(1, positive(delay?.min, fallback.min));
  let max = Math.max(1, positive(delay?.max, fallback.max));
  if (max < min) [min, max] = [max, min];
  return { min, max };
}

// Accepts a string id or { id, delaySeconds, maxMessagesPerHour }.
// Missing fields fall back to the global values. Returns null when there is no id.
export function resolveTesterSettings(entry, globals) {
  const id = typeof entry === 'string' ? entry : entry?.id;
  if (!id) return null;

  const object = typeof entry === 'object' ? entry : {};
  const globalDelay = normalizeDelay(globals.delaySeconds, { min: 20, max: 60 });

  return {
    id,
    delaySeconds: normalizeDelay(object.delaySeconds, globalDelay),
    maxPerHour: Math.max(
      1,
      Math.floor(
        positive(
          object.maxMessagesPerHour,
          positive(globals.maxMessagesPerTesterPerHour, 40),
        ),
      ),
    ),
  };
}

export const nextDelayMs = (settings, random = Math.random) =>
  (settings.delaySeconds.min +
    random() * (settings.delaySeconds.max - settings.delaySeconds.min)) *
  1000;

// Staggered start: a random offset in [0, delaySeconds.max].
export const initialOffsetMs = (settings, random = Math.random) =>
  random() * settings.delaySeconds.max * 1000;

export const pruneSentAt = (sentAt, now = Date.now()) =>
  sentAt.filter((at) => now - at < HOUR_MS);

// 0 when the tester may send now; otherwise ms until the oldest message
// leaves the one-hour window (plus a 1s safety margin).
export function hourlyWaitMs(sentAt, now, maxPerHour) {
  const recent = pruneSentAt(sentAt, now);
  if (recent.length < maxPerHour) return 0;
  return Math.max(1000, HOUR_MS - (now - recent[0]) + 1000);
}

// Wait before retrying something that keeps failing: base, 2x, 4x ... capped at max.
export const backoffMs = (failures, baseMs, maxMs) =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.floor(Number(failures) || 0)));

// Upper-bound estimate: ignores typing time and API latency.
export function estimateRates(testers) {
  const perTester = testers.map((tester) => {
    const avgDelaySeconds =
      (tester.delaySeconds.min + tester.delaySeconds.max) / 2;
    const perHour = Math.min(3600 / avgDelaySeconds, tester.maxPerHour);
    return { id: tester.id, avgDelaySeconds, maxPerHour: tester.maxPerHour, perHour };
  });

  return {
    perTester,
    totalPerHour: perTester.reduce((sum, t) => sum + t.perHour, 0),
  };
}

export function formatEstimate(estimate) {
  const lines = ['Expected load (upper bound, one local model call per tester message):'];

  for (const t of estimate.perTester) {
    lines.push(
      `  ${t.id}: ~${t.perHour.toFixed(1)}/h ` +
        `(avg delay ${t.avgDelaySeconds}s, cap ${t.maxPerHour}/h)`,
    );
  }

  lines.push(
    `  Total: ~${estimate.totalPerHour.toFixed(1)} messages/h = ` +
      `~${Math.round(estimate.totalPerHour)} tester API calls/hour`,
  );

  return lines.join('\n');
}

// ---- Automatic pacing from health ----
// Pure policy: the health account (see health-analysis.js) goes in, a pace comes out.

const BIDIRECTIONAL_FLOOR = 0.5;
const BIDIRECTIONAL_DROP = 0.05;
const EPSILON = 1e-9;
const PHASE_NAMES = { 1: 'fragile', 2: 'growing', 3: 'stable' };
const FIXED_PACES = {
  1: { delaySeconds: { min: 240, max: 480 }, maxPerHour: 8 },
  2: { delaySeconds: { min: 120, max: 240 }, maxPerHour: 20 },
};

export const AUTO_PACING_DEFAULTS = { enabled: true, recheckHours: 6, windowDays: 14 };

export function normalizeAutoPacing(value) {
  const object = value && typeof value === 'object' ? value : {};
  return {
    enabled: object.enabled !== false,
    recheckHours: positive(object.recheckHours, AUTO_PACING_DEFAULTS.recheckHours),
    windowDays: Math.max(1, Math.floor(positive(object.windowDays, AUTO_PACING_DEFAULTS.windowDays))),
  };
}

// An object entry with its own delay or cap is manual mode: auto pacing never touches it.
export const isManualPacing = (entry) =>
  Boolean(entry) &&
  typeof entry === 'object' &&
  (entry.delaySeconds !== undefined || entry.maxMessagesPerHour !== undefined);

const phaseFromDays = (days) => (days <= 3 ? 1 : days <= 10 ? 2 : 3);
const copyDelay = (delay) => ({ min: delay.min, max: delay.max });
const paceText = (pace) =>
  `${pace.maxPerHour}/h, ${pace.delaySeconds.min}-${pace.delaySeconds.max}s`;

function basePace(level, defaults) {
  const fixed = FIXED_PACES[level];
  if (fixed) return { delaySeconds: copyDelay(fixed.delaySeconds), maxPerHour: fixed.maxPerHour };
  return { delaySeconds: copyDelay(defaults.delaySeconds), maxPerHour: defaults.maxPerHour };
}

// account: result of analyzeClient (or { error }). defaults: { delaySeconds, maxPerHour }
// used for phase 3. trend: compareToPrevious() result for this session, if any.
export function paceFromHealth(account, defaults, { trend } = {}) {
  if (!account || account.error || !Number.isFinite(account.days)) {
    const pace = basePace(1, defaults);
    const why = account?.error ? String(account.error) : 'no health data';
    return {
      level: 1,
      phase: 1,
      downgraded: false,
      fallback: true,
      ...pace,
      reason: `analysis failed (${why}), safe default phase 1 -> ${paceText(pace)}`,
    };
  }

  const phase = account.phase?.phase ?? phaseFromDays(account.days);
  const incidents = account.incidents?.total ?? 0;
  const bidirectional = account.bidirectional;
  const drop = trend?.bidirectional?.delta;

  const triggers = [];
  if (incidents > 0) triggers.push(`${incidents} incident(s) in window`);
  if (typeof bidirectional === 'number' && bidirectional < BIDIRECTIONAL_FLOOR) {
    triggers.push(`bidir below ${BIDIRECTIONAL_FLOOR * 100}%`);
  }
  if (typeof drop === 'number' && drop <= -BIDIRECTIONAL_DROP + EPSILON) {
    triggers.push(`bidir dropped ${Math.round(-drop * 100)} pts vs previous run`);
  }

  const downgraded = triggers.length > 0;
  const level = downgraded ? Math.max(1, phase - 1) : phase;
  const pace = basePace(level, defaults);
  if (downgraded && phase === 1) pace.maxPerHour = Math.max(1, Math.floor(pace.maxPerHour / 2));

  const bidirText = typeof bidirectional === 'number' ? `${Math.round(bidirectional * 100)}%` : 'n/a';
  const base = `phase ${phase} ${PHASE_NAMES[phase]}, ${incidents} incidents, bidir ${bidirText}`;
  const note = downgraded ? ` [downgraded: ${triggers.join('; ')}]` : '';

  // Analysis failed but a recent saved report stood in for it: say so in the reason.
  const origin = account.fallbackFrom
    ? `analysis failed (${account.fallbackError ?? 'unknown error'}); using last report from ${String(account.fallbackFrom).slice(0, 10)}: `
    : '';

  return {
    level,
    phase,
    downgraded,
    fallback: false,
    ...pace,
    reason: `${origin}${base}${note} -> ${paceText(pace)}`,
  };
}

// Returns run(task): starts task() when fewer than `max` are running, otherwise queues it (FIFO).
// A task that throws frees its slot; its rejection goes to that task's own caller.
export function createLimiter(max) {
  const cap = Number.isInteger(max) && max > 0 ? max : 1;
  const queue = [];
  let active = 0;

  const next = () => {
    if (active >= cap || queue.length === 0) return;
    const { task, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

// Decides the settings a tester should use. `settings` comes from resolveTesterSettings and is
// returned untouched for manual testers or when auto pacing is off.
export function pickPacing({ entry, settings, autoPacing, account, trend, defaults }) {
  if (!autoPacing?.enabled) return { mode: 'off', settings, reason: 'auto pacing disabled' };

  if (isManualPacing(entry)) {
    return {
      mode: 'manual',
      settings,
      reason: `manual override in config -> ${paceText(settings)}`,
    };
  }

  const base = defaults ?? { delaySeconds: settings.delaySeconds, maxPerHour: settings.maxPerHour };
  const pace = paceFromHealth(account, base, { trend });

  return {
    mode: 'auto',
    pace,
    reason: pace.reason,
    settings: { id: settings.id, delaySeconds: pace.delaySeconds, maxPerHour: pace.maxPerHour },
  };
}

// A tester with no analysis yet is due; a failed one is retried within an hour.
export function recheckDue(lastCheckedAt, now, recheckHours, failed = false) {
  if (!Number.isFinite(lastCheckedAt)) return true;
  const hours = failed ? Math.min(recheckHours, 1) : recheckHours;
  return now - lastCheckedAt >= hours * HOUR_MS;
}

// null when the pace did not change.
export function describePaceChange(id, before, after, reason) {
  const same =
    before.maxPerHour === after.maxPerHour &&
    before.delaySeconds.min === after.delaySeconds.min &&
    before.delaySeconds.max === after.delaySeconds.max;
  if (same) return null;

  const fmt = (p) => `${p.maxPerHour}/h (${p.delaySeconds.min}-${p.delaySeconds.max}s)`;
  return `${id} pace ${fmt(before)} -> ${fmt(after)}: ${reason}`;
}

// items: { id, number, phase, bidirectional, incidents, settings, reason }
export function formatPacingTable(items) {
  const dash = (v) => (v === null || v === undefined ? '-' : String(v));
  const rows = [
    ['tester', 'number', 'phase', 'bidir %', 'incidents', 'pace', 'reason'],
    ...items.map((i) => [
      i.id,
      i.number ? `+${i.number}` : '-',
      dash(i.phase),
      typeof i.bidirectional === 'number' ? `${Math.round(i.bidirectional * 100)}%` : '-',
      dash(i.incidents),
      paceText(i.settings),
      i.reason ?? '',
    ]),
  ];

  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows
    .map((r) =>
      r
        .map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
