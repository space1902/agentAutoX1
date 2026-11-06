// Account maturity report for the warm-up sessions (bot + testers).
// Run with: node health.js [--days N] [--probe] [--history N]
//
// WhatsApp exposes no official reputation for personal accounts, so this computes proxies from
// the chat history each session can see, plus the event log written by lib.js.
import {
  exitCleanlyOnCtrlC,
  loadConfig,
  pauseStore,
  readEvents,
  resolveGroupId,
  sleep,
  startClient,
  stopAllClients,
  stopClient,
} from './lib.js';
import {
  analyzeClient,
  finalizeAccount,
  readCsvTexts,
  readHistory,
  writeHealthReport,
} from './health-analysis.js';
import {
  compareToPrevious,
  formatTrend,
  historyRows,
  pointFromAccount,
} from './health-metrics.js';
import { testerIds } from './session-selection.js';

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_URL = 'https://www.wikipedia.org';
// 1x1 transparent PNG.
const PROBE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const daysArg = args.indexOf('--days');
const WINDOW_DAYS = daysArg >= 0 ? Math.max(1, Number(args[daysArg + 1]) || 14) : 14;
const historyArg = args.indexOf('--history');
const HISTORY_RUNS = historyArg >= 0 ? Math.max(1, Math.floor(Number(args[historyArg + 1])) || 10) : 10;

const pct = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);

function printTrend(accounts, history, nowIso) {
  const sessions = accounts.filter((a) => !a.error && a.verdict);
  const withPrev = sessions.filter((a) => history[a.session]?.length);

  if (withPrev.length === 0) {
    console.log('\nNo previous runs yet; history starts now.');
    return;
  }

  for (const a of withPrev) {
    const prev = history[a.session].at(-1);
    const date = prev.at.slice(0, 10);
    console.log(`\n=== Trend vs previous run (${date}) ===`);
    console.log(formatTrend(a.session, compareToPrevious(pointFromAccount(a, nowIso), prev)));
  }

  console.log(`\n=== History (last ${HISTORY_RUNS} runs) ===`);
  for (const a of withPrev) {
    const series = [...history[a.session], pointFromAccount(a, nowIso)];
    console.log(`\n${a.session}`);
    console.table(historyRows(series, HISTORY_RUNS));
  }
  for (const a of sessions.filter((x) => !history[x.session]?.length)) {
    console.log(`\n${a.session}: no previous runs yet; history starts now.`);
  }
}

// Each session posts a link and an image to the group; some other session must receive both.
async function runProbe(clients, groupId) {
  const results = {};

  for (const [sender, senderClient] of Object.entries(clients)) {
    const receivers = Object.entries(clients).filter(([id]) => id !== sender);
    const stamp = Date.now().toString(36);
    const text = `${PROBE_URL} probe ${stamp}`;
    const got = { link: false, image: false };

    const listeners = receivers.map(([, client]) => {
      const onMessage = (msg) => {
        if (msg.from !== groupId) return;
        if (msg.body?.includes(`probe ${stamp}`)) got.link = true;
        if (msg.hasMedia && msg.type === 'image' && (msg.body ?? '').includes(stamp)) got.image = true;
      };
      client.on('message', onMessage);
      return () => client.removeListener('message', onMessage);
    });

    try {
      await senderClient.sendText(groupId, text);
      await sleep(2000);
      await senderClient.sendImage(groupId, PROBE_PNG, `image ${stamp}`);

      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      while (Date.now() < deadline && !(got.link && got.image)) await sleep(1000);
    } catch (error) {
      results[sender] = { probe: 'fail', detail: `send failed: ${error?.message || error}` };
      listeners.forEach((off) => off());
      continue;
    }

    listeners.forEach((off) => off());
    const ok = got.link && got.image;
    results[sender] = {
      probe: ok ? 'pass' : 'fail',
      detail: ok ? 'link and image received' : `link ${got.link ? 'ok' : 'missing'}, image ${got.image ? 'ok' : 'missing'}`,
    };
  }

  return results;
}

function printAccount(a) {
  const verdict = a.verdict;
  console.log(`\n=== ${a.session} (${a.pushname ?? '?'} / +${a.number ?? '?'} / ${a.platform ?? '?'}) ===`);
  console.log(`Days since first recorded activity: ${a.days} (lower bound, first seen ${a.firstActivity ?? 'n/a'})`);
  const range = Number.isFinite(a.phase.max) ? `${a.phase.min}-${a.phase.max}` : `${a.phase.min}+`;
  console.log(`Phase ${a.phase.phase} "${a.phase.name}": recommended ${range} active chats/day`);
  console.log(`Active chats: today ${a.todayActive}, average ${a.avgActive.toFixed(1)}/day over the window`);
  console.log(`Bidirectional ratio: ${pct(a.bidirectional)}   Rich incoming ratio: ${pct(a.richIncoming)}`);
  console.log(
    `Incidents (last ${WINDOW_DAYS}d): qr ${a.incidents.qr}, disconnected ${a.incidents.disconnected}, ` +
      `auth_failure ${a.incidents.auth_failure}`,
  );
  console.log(`History read: ${a.messagesInWindow} messages in ${a.chatsSeen} chats (${a.chatsSkipped} skipped)`);
  for (const w of a.warnings) console.log(`WARNING: ${w}`);
  if (a.probe !== 'skipped') console.log(`Probe: ${a.probe} (${a.probeDetail})`);
  console.log(
    `Ready for sales: ${verdict.verdict}${verdict.verdict === 'READY' && !verdict.verified ? ' (not verified: no probe)' : ''}`,
  );
  for (const r of verdict.reasons) console.log(`  - ${r}`);
}

function printSummary(accounts) {
  console.log('\n=== Summary ===');
  const rows = accounts.map((a) => ({
    session: a.session,
    number: a.number ? `+${a.number}` : a.error ? 'ERROR' : '?',
    phase: a.phase ? `${a.phase.phase} ${a.phase.name}` : '-',
    days: a.days ?? '-',
    'avg chats/day': a.avgActive !== undefined ? a.avgActive.toFixed(1) : '-',
    'bidir %': a.bidirectional !== undefined ? pct(a.bidirectional) : '-',
    incidents: a.incidents?.total ?? '-',
    verdict: a.verdict ? a.verdict.verdict + (a.verdict.verified ? '' : ' (unverified)') : 'ERROR',
  }));
  console.table(rows);
}

async function main() {
  const config = loadConfig(['bot', 'testers']);
  const sessions = [config.bot.sessionId, ...testerIds(config.testers)];
  const history = readHistory();
  const events = readEvents();
  const csvTexts = readCsvTexts();
  const now = new Date();

  console.log(`Health report for ${sessions.join(', ')} (window: ${WINDOW_DAYS} days)`);
  console.log('Phases and thresholds are community heuristics, NOT official WhatsApp limits.');
  if (PROBE) {
    console.log('WARNING: --probe posts a link and an image from each session to the test group.');
  }

  const accounts = [];
  const open = {};

  for (const session of sessions) {
    try {
      // A paused number keeps its socket closed, also for the health report.
      const pause = pauseStore.get(session);
      if (pause) {
        console.warn(`[${session}] is paused (${pause.reason}); not connecting it. Resume it first to include it.`);
        accounts.push({ session, error: `paused (${pause.reason})` });
        continue;
      }
      console.log(`\nStarting ${session}...`);
      const client = await startClient(session);
      const account = await analyzeClient(session, client, {
        days: WINDOW_DAYS,
        csvTexts,
        events: readEvents(),
        now,
      });
      accounts.push(account);

      if (PROBE) open[session] = client;
      else await stopClient(client);
    } catch (error) {
      console.error(`[${session}] failed: ${error?.message || error}`);
      accounts.push({ session, error: String(error?.message || error) });
    }
  }

  if (PROBE) {
    const ids = Object.keys(open);
    if (ids.length < 2) {
      console.warn('Probe needs at least 2 connected sessions; skipping it.');
    } else {
      const groupId = await resolveGroupId(open[ids[0]], config);
      const results = await runProbe(open, groupId);
      for (const account of accounts) {
        if (results[account.session]) {
          account.probe = results[account.session].probe;
          account.probeDetail = results[account.session].detail;
        }
      }
    }
  }

  for (const a of accounts) {
    if (a.error) continue;
    // Incidents recorded while this very run was starting the session also count.
    finalizeAccount(a, { events: readEvents(), now, windowDays: WINDOW_DAYS });
    printAccount(a);
  }

  printSummary(accounts);
  printTrend(accounts, history, now.toISOString());

  const file = writeHealthReport({ accounts, history, now, windowDays: WINDOW_DAYS });
  console.log(`\nFull report written to ${file}`);
}

exitCleanlyOnCtrlC();

try {
  await main();
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
} finally {
  await stopAllClients();
}
