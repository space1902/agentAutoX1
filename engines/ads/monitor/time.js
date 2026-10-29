// Time helpers. ALL hour logic in this project uses the ad account timezone, never the machine's.
const formatters = new Map();

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }),
    );
  }
  return formatters.get(tz);
}

// Epoch ms -> wall-clock parts in the given IANA timezone.
export function localParts(ms, tz) {
  const parts = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(ms))) parts[type] = value;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

// Start (epoch ms, minute precision) of the local day that contains `ms`.
export function startOfLocalDay(ms, tz) {
  const { minutesOfDay } = localParts(ms, tz);
  return ms - (ms % 60_000) - minutesOfDay * 60_000;
}

// { start, end } in whole hours; ranges may wrap midnight (start > end). start === end means never.
export function inHourRange(hour, { start, end }) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// 'YYYY-MM-DD' + n days (pure calendar arithmetic, no timezone involved).
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const minutes = (n) => n * 60_000;
