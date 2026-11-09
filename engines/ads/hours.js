// Hour-of-day window for sales. The sheet registers each payment as "d/m/yyyy H:mm:ss" in America/Bogota, so the hour
// is read straight from that text. A window is { start, end }: start inclusive, end exclusive, wrapping past midnight
// when start > end (22-6 = 22:00 to 05:59). null = the whole day. Pure.

export class HoursError extends Error {}

const RANGE = /^(\d{1,2})-(\d{1,2})$/;

// "8-14" -> { start: 8, end: 14 }; empty / "0-24" -> null (whole day). Anything else is refused.
export function parseHoursArg(value) {
  if (value === undefined || value === null || value === true || String(value).trim() === '') return null;
  const m = RANGE.exec(String(value).trim());
  if (!m) throw new HoursError('El horario debe verse como 8-14 (hora de inicio y de fin).');
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24 || start === end) throw new HoursError('El horario no es válido: usa horas de 0 a 24 y que el inicio sea distinto del fin.');
  if (start === 0 && end === 24) return null;
  return { start, end };
}

// Hour (0-23) of a registration timestamp, or null when the text has no readable time.
export function hourOfRegistered(text) {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?\s?m\.?)?/i.exec(String(text ?? ''));
  if (!m) return null;
  let hour = Number(m[1]);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  }
  return hour >= 0 && hour <= 23 && Number(m[2]) <= 59 ? hour : null;
}

// Is an hour inside the window? No window = always; a payment without a readable time is outside any window.
export function inHours(hour, window) {
  if (!window) return true;
  if (hour === null || hour === undefined) return false;
  return window.start < window.end ? hour >= window.start && hour < window.end : hour >= window.start || hour < window.end;
}
