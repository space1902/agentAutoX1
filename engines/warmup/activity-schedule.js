// Daily activity window and daily message caps per WhatsApp number. Pure functions: no I/O, no timers,
// the clock and the random source are always passed in, so everything is unit tested.
//
// - Window: each number has its own start (about 07:00-09:30) and end (about 20:30-22:30) in a time zone
//   (America/Bogota by default). Both are derived from a hash of the session name and the local date, so
//   they change from day to day, differ between numbers and are identical after a restart on the same day.
// - Low-activity day: exactly one day per 7-day block, at 30% of the cap; the day inside the block is a
//   hash of the session name and the block, so numbers do not share the same quiet day.
// - Daily cap by account age; an incident drops one level (the lowest level is halved instead).
// These are community heuristics, NOT official WhatsApp limits.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const SCHEDULE_DEFAULTS = Object.freeze({
  enabled: true,
  timezone: 'America/Bogota',
  window: {
    start: { min: '07:00', max: '09:30' },
    end: { min: '20:30', max: '22:30' },
  },
  lowActivityFactor: 0.3,
  dailyCaps: { days1to3: 20, days4to7: 40, days8to14: 80, days15plus: 150 },
  botDailyCap: 150,
});

// ---- time zones ----

const formatters = new Map();
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    formatterFor(timeZone.trim());
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant in a time zone.
function zonedParts(ms, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

// The wall clock of `ms` in the zone, read back as if it were UTC.
const wallAsUtc = (ms, timeZone) => {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
};

const pad = (n) => String(n).padStart(2, '0');

// Local calendar day (YYYY-MM-DD) of an instant in the zone. NOT the UTC day.
export function dateKeyFor(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

const epochDay = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};

// The instant at which the zone's wall clock reads `minutesOfDay` on `dateKey`.
export function zonedWallToUtcMs(dateKey, minutesOfDay, timeZone) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutesOfDay);
  const first = guess - (wallAsUtc(guess, timeZone) - guess);
  // A second pass corrects the offset when the first guess landed across a DST change.
  return guess - (wallAsUtc(first, timeZone) - first);
}

// ---- deterministic randomness ----

function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 finalizer: spreads similar inputs across the whole range.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const unit = (key) => hash32(key) / 0x1_0000_0000;

// ---- configuration ----

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function normalizeRange(value, fallback) {
  const defaults = { min: parseClock(fallback.min), max: parseClock(fallback.max) };
  const min = parseClock(value?.min);
  const max = parseClock(value?.max);
  if (min === null || max === null) return defaults;
  return min <= max ? { min, max } : { min: max, max: min };
}

const positiveInt = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// config.schedule -> a complete, validated schedule. Anything absent or invalid takes the default.
export function normalizeSchedule(value) {
  const object = value && typeof value === 'object' ? value : {};
  const d = SCHEDULE_DEFAULTS;

  let start = normalizeRange(object.window?.start, d.window.start);
  let end = normalizeRange(object.window?.end, d.window.end);
  // The window must keep at least 4 hours open, otherwise the spread pacing makes no sense.
  if (end.min - start.max < 240) {
    start = normalizeRange(undefined, d.window.start);
    end = normalizeRange(undefined, d.window.end);
  }

  const factor = Number(object.lowActivityFactor);
  const caps = object.dailyCaps && typeof object.dailyCaps === 'object' ? object.dailyCaps : {};

  return {
    enabled: object.enabled !== false,
    timezone: isValidTimeZone(object.timezone) ? object.timezone.trim() : d.timezone,
    start,
    end,
    lowActivityFactor: factor > 0 && factor <= 1 ? factor : d.lowActivityFactor,
    caps: [
      { untilDay: 3, cap: positiveInt(caps.days1to3, d.dailyCaps.days1to3) },
      { untilDay: 7, cap: positiveInt(caps.days4to7, d.dailyCaps.days4to7) },
      { untilDay: 14, cap: positiveInt(caps.days8to14, d.dailyCaps.days8to14) },
      { untilDay: Infinity, cap: positiveInt(caps.days15plus, d.dailyCaps.days15plus) },
    ],
    botDailyCap: positiveInt(object.botDailyCap, d.botDailyCap),
  };
}

// entry: a config tester entry (string or { id, timezone }); a per-entry zone (México numbers) wins.
export function resolveTimezone(schedule, entry) {
  const own = entry && typeof entry === 'object' ? entry.timezone : null;
  return isValidTimeZone(own) ? own.trim() : schedule.timezone;
}

// ---- window, low-activity day, caps ----

export function dayWindow(sessionId, dateKey, schedule, timeZone) {
  const pick = (range, salt) =>
    Math.round(range.min + unit(`${sessionId}|${dateKey}|${salt}`) * (range.max - range.min));
  const startMinutes = pick(schedule.start, 'start');
  const endMinutes = pick(schedule.end, 'end');
  return {
    dateKey,
    startMs: zonedWallToUtcMs(dateKey, startMinutes, timeZone),
    endMs: zonedWallToUtcMs(dateKey, endMinutes, timeZone),
  };
}

// Exactly one low-activity day in every 7-day block; which one depends on the session and the block.
export function isLowActivityDay(sessionId, dateKey) {
  const day = epochDay(dateKey);
  const block = Math.floor(day / 7);
  const lowDay = Math.floor(unit(`${sessionId}|low|${block}`) * 7);
  return day - block * 7 === lowDay;
}

function levelForDays(days) {
  if (!Number.isFinite(days) || days < 1) return 0;
  if (days <= 3) return 0;
  if (days <= 7) return 1;
  if (days <= 14) return 2;
  return 3;
}

// Cap by age. An incident drops one level; the lowest level is halved. Unknown age = lowest level.
export function dailyCap({ days, incidents = 0, schedule }) {
  let level = levelForDays(days);
  const downgraded = incidents > 0;
  let cap;
  if (downgraded && level > 0) {
    level -= 1;
    cap = schedule.caps[level].cap;
  } else if (downgraded) {
    cap = Math.max(1, Math.floor(schedule.caps[0].cap / 2));
  } else {
    cap = schedule.caps[level].cap;
  }
  return { cap, level, downgraded };
}

// ---- gate ----

// state: 'active' | 'outside_window' | 'capped'. count = messages already sent on the local day.
// flatCap (the bot) replaces the age-based cap. With the schedule off the gate is always open.
export function evaluateGate({ sessionId, now, count = 0, days, incidents = 0, flatCap = null, schedule, timezone }) {
  const dateKey = dateKeyFor(now, timezone);

  if (!schedule.enabled) {
    return { state: 'active', enabled: false, dateKey, window: null, baseCap: null, cap: null, low: false, count, nextOpenMs: null };
  }

  const window = dayWindow(sessionId, dateKey, schedule, timezone);
  const baseCap = flatCap ?? dailyCap({ days, incidents, schedule }).cap;
  const low = isLowActivityDay(sessionId, dateKey);
  const cap = low ? Math.max(1, Math.round(baseCap * schedule.lowActivityFactor)) : baseCap;
  const nextDay = () => dayWindow(sessionId, addDays(dateKey, 1), schedule, timezone).startMs;
  const result = { enabled: true, dateKey, window, baseCap, cap, low, count };

  if (now < window.startMs) return { ...result, state: 'outside_window', nextOpenMs: window.startMs };
  if (now >= window.endMs) return { ...result, state: 'outside_window', nextOpenMs: nextDay() };
  if (count >= cap) return { ...result, state: 'capped', nextOpenMs: nextDay() };
  return { ...result, state: 'active', nextOpenMs: null };
}

// Milliseconds to wait before the next send so the remaining cap is spread over the remaining window
// (with jitter, never a fixed beat). 0 when there is no cap, no room left, or no window left.
export function spreadDelayMs({ now, windowEndMs, cap, count, random = Math.random }) {
  if (!Number.isFinite(cap) || cap === null) return 0;
  const remaining = cap - count;
  const span = windowEndMs - now;
  if (remaining <= 0 || span <= 0) return 0;
  return (span / remaining) * (0.6 + 0.8 * random());
}

export { DAY_MS, MINUTE_MS };
