// Reusable per-client health analysis (shared by health.js and tester.js).
// Importing this module has no side effects: it never opens a session by itself.
import fs from 'node:fs';
import path from 'node:path';

import { RESULTS_DIR, readEvents } from './lib.js';
import {
  aggregateByDay,
  bidirectionalRatio,
  classifyPhase,
  daysSince,
  earliestCsvDate,
  loadHistory,
  localDateKey,
  readinessVerdict,
  richIncomingRatio,
  summarizeIncidents,
  trendForReport,
} from './health-metrics.js';

const DAY_MS = 86_400_000;

export function readCsvTexts() {
  const dir = RESULTS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('run-') && name.endsWith('.csv'))
    .map((name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        // A CSV still being written by another process is not fatal.
        return '';
      }
    });
}

// Parsed results/health-*.json reports; unreadable or invalid files are ignored.
export function readHealthReports() {
  const dir = RESULTS_DIR;
  if (!fs.existsSync(dir)) return [];
  const reports = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('health-') || !name.endsWith('.json')) continue;
    try {
      reports.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      // Skip corrupt or half-written reports.
    }
  }
  return reports;
}

export const readHistory = () => loadHistory(readHealthReports());

// Messages inside the window, plus the earliest outgoing one ever seen. Baileys keeps no chat
// history, so these come from the activity log the client writes (metadata only, since the
// migration to Baileys). isStopped() is checked first so a cancelled analysis ends quickly.
export async function collectMessages(client, sinceSeconds, { isStopped = () => false } = {}) {
  if (isStopped()) throw new Error('analysis cancelled');
  return client.readActivity(sinceSeconds);
}

export function buildAccount(session, info, collected, events, csvTexts, now, windowDays) {
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const perDay = aggregateByDay(collected.messages);

  const candidates = [
    events.filter((e) => e.session === session && e.event === 'ready').map((e) => e.at)[0],
    earliestCsvDate(csvTexts, session),
    collected.earliestSent ? new Date(collected.earliestSent * 1000).toISOString() : null,
  ].filter(Boolean);
  const firstActivity = candidates.sort((a, b) => new Date(a) - new Date(b))[0] ?? null;

  const days = daysSince(firstActivity, now);
  const phase = classifyPhase(days);
  const effectiveWindow = Math.max(1, Math.min(days, windowDays));
  const totalActive = Object.values(perDay).reduce((sum, d) => sum + d.activeChats, 0);
  const todayActive = perDay[localDateKey(now.getTime() / 1000)]?.activeChats ?? 0;
  const avgActive = totalActive / effectiveWindow;

  const warnings = [];
  if (todayActive > phase.max) warnings.push(`today's active chats (${todayActive}) exceed ${phase.max}`);
  if (avgActive > phase.max) warnings.push(`average active chats/day (${avgActive.toFixed(1)}) exceed ${phase.max}`);

  return {
    session,
    pushname: info?.pushname ?? null,
    number: info?.wid?.user ?? null,
    platform: info?.platform ?? null,
    firstActivity,
    days,
    phase,
    todayActive,
    avgActive,
    bidirectional: bidirectionalRatio(collected.messages),
    richIncoming: richIncomingRatio(collected.messages),
    perDay,
    incidents: summarizeIncidents(events, session, since),
    messagesInWindow: collected.messages.length,
    chatsSeen: collected.chatsSeen,
    chatsSkipped: collected.chatsSkipped,
    warnings,
    probe: 'skipped',
    probeDetail: null,
  };
}

// Recompute incidents and the verdict (call again after a probe or when events changed).
export function finalizeAccount(account, { events, now, windowDays }) {
  account.incidents = summarizeIncidents(events, account.session, new Date(now.getTime() - windowDays * DAY_MS));
  account.verdict = readinessVerdict({
    days: account.days,
    incidents: account.incidents.total,
    bidirectionalRatio: account.bidirectional,
    probe: account.probe,
  });
  return account;
}

// Full analysis of one already-open client. Does not open or close anything.
export async function analyzeClient(
  session,
  client,
  { days = 14, csvTexts = [], events = readEvents(), now = new Date(), isStopped } = {},
) {
  const sinceSeconds = now.getTime() / 1000 - days * 86_400;
  const collected = await collectMessages(client, sinceSeconds, { isStopped });
  const account = buildAccount(session, client.info, collected, events, csvTexts, now, days);
  return finalizeAccount(account, { events, now, windowDays: days });
}

// Writes results/health-<ts>.json with the same shape health.js has always produced.
// `history` must be the history read BEFORE this report is written.
export function writeHealthReport({ accounts, history, now, windowDays }) {
  const dir = RESULTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `health-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  const report = {
    generatedAt: now.toISOString(),
    windowDays,
    note: 'Phases are community heuristics, not official WhatsApp limits. Account age is a lower bound.',
    trend: trendForReport(accounts, history),
    accounts,
  };
  fs.writeFileSync(file, `${JSON.stringify(report, (_, v) => (v === Infinity ? 'Infinity' : v), 2)}\n`, 'utf8');
  return file;
}
