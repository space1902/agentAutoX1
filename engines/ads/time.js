// Date helpers (adapted from meta-ads-monitor). Calendar arithmetic is timezone-free; "today" is always
// computed in the ad account timezone, never the machine's.
const formatters = new Map();

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }),
    );
  }
  return formatters.get(tz);
}

// Epoch ms -> wall-clock parts in the given IANA timezone.
export function localParts(ms, tz) {
  const parts = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(ms))) parts[type] = value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());

// 'YYYY-MM-DD' + n days.
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Whole days from a to b (b - a).
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// Every date from..to inclusive (capped to keep a bad range from exploding).
export function eachDate(from, to, cap = 800) {
  const out = [];
  for (let d = from; d <= to && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}

// Splits a range into chunks of at most `days` days.
export function chunkRange(from, to, days = 31) {
  const chunks = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    chunks.push({ since: start, until: end < to ? end : to });
  }
  return chunks;
}

// Epoch ms of a wall-clock date + hour in an IANA timezone (the hour's start). Two correction passes handle offsets,
// including DST; an hour that does not exist (spring forward) lands on the next valid instant.
export function zonedEpoch(date, hour, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    guess += wanted - Date.UTC(py, pm - 1, pd, p.hour, p.minute);
  }
  return guess;
}

// Wall-clock { date, hour } in `fromTz` -> the hour of the same instant in `toTz`. When the zones differ by a fraction of
// an hour (e.g. +5:30) the result is the toTz hour that contains the START of the source hour.
export function convertHour(date, hour, fromTz, toTz) {
  if (fromTz === toTz) return { date, hour };
  const p = localParts(zonedEpoch(date, hour, fromTz), toTz);
  return { date: p.date, hour: p.hour };
}
