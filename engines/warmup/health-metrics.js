// Pure metrics for health.js: no WhatsApp, no disk. Everything here is unit tested.

export const RICH_BODY_MIN_CHARS = 40;
export const READY_MIN_DAYS = 14;
export const READY_MIN_BIDIRECTIONAL = 0.5;

const pad = (n) => String(n).padStart(2, '0');

// Local calendar date (YYYY-MM-DD) of a unix timestamp in seconds.
export function localDateKey(timestampSeconds) {
  const d = new Date(timestampSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Community heuristics, NOT official WhatsApp numbers.
export function classifyPhase(days) {
  if (days <= 3) return { phase: 1, name: 'Fragile', min: 5, max: 10 };
  if (days <= 10) return { phase: 2, name: 'Growing', min: 15, max: 30 };
  return { phase: 3, name: 'Stable', min: 50, max: Infinity };
}

// Day 1 is the first local calendar day with recorded activity.
export function daysSince(isoDate, now = new Date()) {
  if (!isoDate) return 0;
  const first = new Date(isoDate);
  if (Number.isNaN(first.getTime())) return 0;
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(now) - startOf(first)) / 86_400_000) + 1;
}

export function aggregateByDay(messages) {
  const days = {};
  const chatsByDay = {};

  for (const m of messages) {
    const key = localDateKey(m.timestamp);
    days[key] ??= { outgoing: 0, incoming: 0, activeChats: 0 };
    if (m.fromMe) {
      days[key].outgoing++;
      (chatsByDay[key] ??= new Set()).add(m.chatId);
    } else {
      days[key].incoming++;
    }
  }

  for (const [key, chats] of Object.entries(chatsByDay)) days[key].activeChats = chats.size;
  return days;
}

// Among chats where we sent something, the fraction where someone else also wrote.
export function bidirectionalRatio(messages) {
  const sent = new Set();
  const received = new Set();
  for (const m of messages) (m.fromMe ? sent : received).add(m.chatId);
  if (sent.size === 0) return null;
  let both = 0;
  for (const chatId of sent) if (received.has(chatId)) both++;
  return both / sent.size;
}

// Long messages and voice notes are a rough sign of real conversations.
export function richIncomingRatio(messages) {
  const incoming = messages.filter((m) => !m.fromMe);
  if (incoming.length === 0) return null;
  const rich = incoming.filter(
    (m) =>
      (m.bodyLength ?? String(m.body ?? '').length) >= RICH_BODY_MIN_CHARS ||
      m.type === 'ptt' ||
      m.type === 'audio',
  );
  return rich.length / incoming.length;
}

// Minimal RFC 4180 parser: quoted fields may contain commas, doubled quotes and newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Earliest timestamp (as the original string) of any row written by `tester`.
export function earliestCsvDate(csvTexts, tester) {
  let best = null;
  let bestMs = Infinity;

  for (const text of csvTexts) {
    const [header, ...rows] = parseCsv(text);
    if (!header) continue;
    const tsIdx = header.indexOf('timestamp');
    const testerIdx = header.indexOf('tester');
    if (tsIdx < 0 || testerIdx < 0) continue;

    for (const row of rows) {
      if (row[testerIdx] !== tester) continue;
      const ms = new Date(row[tsIdx]).getTime();
      if (!Number.isNaN(ms) && ms < bestMs) {
        bestMs = ms;
        best = row[tsIdx];
      }
    }
  }
  return best;
}

// A qr only counts as an incident when the session had been ready earlier (a re-link).
// The first qr(s) before any ready are the initial linking. `events` must hold ALL events,
// not just the window, so an older ready is still seen.
export function summarizeIncidents(events, session, since) {
  const counts = { qr: 0, disconnected: 0, auth_failure: 0 };
  let firstReady = Infinity;
  for (const e of events) {
    if (e.session !== session || e.event !== 'ready') continue;
    const ms = new Date(e.at).getTime();
    if (ms < firstReady) firstReady = ms;
  }

  for (const e of events) {
    if (e.session !== session || !(e.event in counts)) continue;
    const ms = new Date(e.at).getTime();
    if (ms < since.getTime()) continue;
    if (e.event === 'qr' && !(firstReady < ms)) continue;
    counts[e.event]++;
  }
  return { ...counts, total: counts.qr + counts.disconnected + counts.auth_failure };
}

const REPORT_MAX_AGE_MS = 48 * 3_600_000;
const DAY_MS_METRICS = 86_400_000;

// Fallback for a failed analysis: the newest saved health report (under maxAgeMs old) holding a
// usable account for `session`. Incidents and verdict are recomputed from the current events.
// Returns { account, generatedAt } or null.
export function accountFromRecentReport(
  reports,
  session,
  { events, now, windowDays, maxAgeMs = REPORT_MAX_AGE_MS },
) {
  let best = null;
  let bestMs = -Infinity;
  for (const report of reports ?? []) {
    const ms = new Date(report?.generatedAt).getTime();
    if (Number.isNaN(ms) || now.getTime() - ms >= maxAgeMs || ms <= bestMs) continue;
    const found = (report.accounts ?? []).find(
      (a) => a?.session === session && !a.error && Number.isFinite(a.days),
    );
    if (!found) continue;
    best = { account: found, generatedAt: report.generatedAt };
    bestMs = ms;
  }
  if (!best) return null;

  const { pacing, verdict, ...rest } = best.account;
  const account = {
    ...rest,
    incidents: summarizeIncidents(events, session, new Date(now.getTime() - windowDays * DAY_MS_METRICS)),
  };
  account.verdict = readinessVerdict({
    days: account.days,
    incidents: account.incidents.total,
    bidirectionalRatio: account.bidirectional,
    probe: account.probe,
  });
  return { account, generatedAt: best.generatedAt };
}

// probe: 'pass' | 'fail' | 'skipped'
export function readinessVerdict({ days, incidents, bidirectionalRatio: ratio, probe }) {
  const reasons = [];
  if (days < READY_MIN_DAYS) reasons.push(`only ${days} day(s) of history, need ${READY_MIN_DAYS}`);
  if (incidents > 0) reasons.push(`${incidents} incident(s) (QR, disconnect or auth failure) in the window`);
  if (ratio === null || ratio === undefined) {
    reasons.push('no outgoing chats to measure the bidirectional ratio');
  } else if (ratio < READY_MIN_BIDIRECTIONAL) {
    reasons.push(`bidirectional ratio ${Math.round(ratio * 100)}% is below ${READY_MIN_BIDIRECTIONAL * 100}%`);
  }
  if (probe === 'fail') reasons.push('delivery probe failed');

  return {
    verdict: reasons.length === 0 ? 'READY' : 'NOT YET',
    reasons,
    verified: probe === 'pass',
  };
}

const BIDIRECTIONAL_DROP_WARNING = 0.05;
const EPSILON = 1e-9;

// Turn parsed health-*.json reports into a time series per session.
// Skips malformed reports and sessions that errored in that run.
export function loadHistory(entries) {
  const history = {};
  if (!Array.isArray(entries)) return history;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.accounts)) continue;
    const at = new Date(entry.generatedAt);
    if (typeof entry.generatedAt !== 'string' || Number.isNaN(at.getTime())) continue;

    for (const a of entry.accounts) {
      if (!a || typeof a !== 'object' || a.error || !a.session || !a.verdict) continue;
      (history[a.session] ??= []).push({
        at: entry.generatedAt,
        days: a.days ?? null,
        avgActive: a.avgActive ?? null,
        todayActive: a.todayActive ?? null,
        bidirectional: a.bidirectional ?? null,
        richIncoming: a.richIncoming ?? null,
        incidents: a.incidents?.total ?? 0,
        verdict: a.verdict?.verdict ?? null,
      });
    }
  }

  for (const series of Object.values(history)) series.sort((x, y) => new Date(x.at) - new Date(y.at));
  return history;
}

// Ratios are compared at whole-percent precision so noise below 1 point reads as "same".
const toPercent = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function delta(previous, current) {
  const usable = typeof previous === 'number' && typeof current === 'number';
  const d = usable ? Math.round((current - previous) * 100) / 100 : null;
  const direction = d === null || Math.abs(d) < EPSILON ? 'same' : d > 0 ? 'up' : 'down';
  return { previous: previous ?? null, current: current ?? null, delta: d, direction };
}

// `current` and `previous` are points as returned by loadHistory (current may be built the same way).
export function compareToPrevious(current, previous) {
  const result = {
    previousAt: previous.at ?? null,
    avgActive: delta(previous.avgActive, current.avgActive),
    bidirectional: delta(toPercent(previous.bidirectional), toPercent(current.bidirectional)),
    richIncoming: delta(toPercent(previous.richIncoming), toPercent(current.richIncoming)),
    incidents: delta(previous.incidents, current.incidents),
    warnings: [],
  };

  const bd = result.bidirectional.delta;
  if (bd !== null && bd <= -BIDIRECTIONAL_DROP_WARNING + EPSILON) {
    result.warnings.push(
      `bidirectional ratio dropped ${Math.round(-bd * 100)} points ` +
        `(${Math.round(previous.bidirectional * 100)}% -> ${Math.round(current.bidirectional * 100)}%)`,
    );
  }
  if (result.incidents.delta !== null && result.incidents.delta > 0) {
    result.warnings.push(`incidents increased (${previous.incidents} -> ${current.incidents})`);
  }
  return result;
}

const ARROWS = { up: '↑', down: '↓', same: '=' };
const pctText = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);

function trendLine(label, m, fmt, fmtDelta) {
  const change = m.delta === null ? '' : ` (${m.delta > 0 ? '+' : ''}${fmtDelta(m.delta)})`;
  return `  ${label}: ${fmt(m.previous)} -> ${fmt(m.current)} ${ARROWS[m.direction]}${m.direction === 'same' ? '' : change}`;
}

export function formatTrend(session, cmp) {
  const date = cmp.previousAt ? cmp.previousAt.slice(0, 10) : '?';
  const num = (v) => (v === null ? 'n/a' : v.toFixed(1));
  const lines = [
    `--- ${session} (vs ${date}) ---`,
    trendLine('Avg chats/day', cmp.avgActive, num, (d) => d.toFixed(1)),
    trendLine('Bidirectional', cmp.bidirectional, pctText, (d) => `${Math.round(d * 100)} pts`),
    trendLine('Rich incoming', cmp.richIncoming, pctText, (d) => `${Math.round(d * 100)} pts`),
    trendLine('Incidents', cmp.incidents, (v) => String(v ?? 'n/a'), (d) => String(d)),
  ];
  for (const w of cmp.warnings) lines.push(`  WARNING: ${w}`);
  return lines.join('\n');
}

// Rows for console.table: the last `limit` points, oldest first.
export function historyRows(series, limit = 10) {
  return series.slice(-limit).map((p) => ({
    date: p.at.slice(0, 16).replace('T', ' '),
    'avg chats/day': p.avgActive === null ? '-' : p.avgActive.toFixed(1),
    'bidir %': pctText(p.bidirectional),
    'rich %': pctText(p.richIncoming),
    incidents: p.incidents,
    verdict: p.verdict ?? '-',
  }));
}

// JSON-safe trend stored in the report.
export function trendForReport(accounts, history) {
  const trend = {};
  for (const a of accounts) {
    if (a.error || !a.verdict) continue;
    const prev = history[a.session]?.at(-1);
    if (!prev) continue;
    trend[a.session] = compareToPrevious(pointFromAccount(a, null), prev);
  }
  return trend;
}

export function pointFromAccount(a, at) {
  return {
    at,
    days: a.days ?? null,
    avgActive: a.avgActive ?? null,
    todayActive: a.todayActive ?? null,
    bidirectional: a.bidirectional ?? null,
    richIncoming: a.richIncoming ?? null,
    incidents: a.incidents?.total ?? 0,
    verdict: a.verdict?.verdict ?? null,
  };
}
