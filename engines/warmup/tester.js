
import fs from 'node:fs';
import path from 'node:path';

import { createAi } from './ai-provider.js';
import { generateUsableMessage } from './local-model.js';
import {
  DATA_DIR,
  RESULTS_DIR,
  cachedGroupId,
  digitsOnly,
  exitCleanlyOnCtrlC,
  formatVoiceLine,
  isEntryPoint,
  isShuttingDown,
  isVoiceMessage,
  loadConfig,
  pauseStore,
  readEvents,
  resolveGroupId,
  sendLikeHuman,
  sendVoiceNote,
  sleep,
  startClient,
  stopAllClients,
  stopClient,
  waitForVoiceTranscript,
  withTimeout,
} from './lib.js';
import {
  DEFAULT_BOT_VOICE,
  DEFAULT_VOICE_POOL,
  assignVoices,
  audioSettings,
  estimateSpeechSeconds,
  shouldSendAudio,
  synthesizeVoiceNote,
} from './voice.js';
import {
  SelectionError,
  parseCount,
  parseRunArgs,
  pickFirst,
  selectTesters,
  testerIds,
} from './session-selection.js';
import { ensureTestersInGroup } from './group-membership.js';
import {
  analyzeClient,
  readCsvTexts,
  readHealthReports,
  readHistory,
  writeHealthReport,
} from './health-analysis.js';
import { accountFromRecentReport, trendForReport } from './health-metrics.js';
import { sessionAge } from './session-age.js';
import { normalizeSchedule, resolveTimezone } from './activity-schedule.js';
import { createSendGate } from './send-gate.js';
import { readActivity } from './wa-activity.js';
import {
  describePaceChange,
  estimateRates,
  formatEstimate,
  formatPacingTable,
  hourlyWaitMs,
  initialOffsetMs,
  nextDelayMs,
  backoffMs,
  normalizeAutoPacing,
  createLimiter,
  pickPacing,
  pruneSentAt,
  recheckDue,
  resolveTesterSettings,
} from './tester-schedule.js';

const DEBUG = process.argv.includes('--debug');

const HISTORY_LIMIT = 15;
const MAX_TOKENS = 120;
const ANALYSIS_TIMEOUT_MS = 3 * 60_000;
const MAX_CONCURRENT_ANALYSES = 3;
// How often a paused or idle tester looks at the pause file and the clock. Long enough to be cheap,
// short enough that Reanudar from the app takes effect within a few seconds.
const PAUSE_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;
// A session that could not reconnect after its pause ended is retried this often.
const REVIVE_RETRY_MS = 5 * 60_000;
// Group membership that cannot be confirmed: wait 5 min, then 10, 20 ... up to 1 h (never a 5 s retry).
const MEMBERSHIP_RETRY_MS = 5 * 60_000;
const MEMBERSHIP_RETRY_MAX_MS = 60 * 60_000;
// The daily-cap age is re-read this often.
const AGE_REFRESH_MS = 60 * 60_000;

const TOPICS = [
  'recetas fáciles para preparar en casa',
  'conversación casual sobre comida y cocina',
  'una pregunta de seguimiento a lo que acaba de decir alguien del grupo',
  'una opinión distinta a la de alguien del grupo',
  'el clima de hoy o de esta semana',
  'un viaje reciente o un lugar que te gustaría conocer',
  'planes para el fin de semana',
  'una serie, película o canción que te gustó',
  'fútbol u otro deporte',
  'el trabajo o los estudios',
  'mascotas',
  'el tráfico, el transporte o algo que pasó en la calle',
  'una celebración o fecha especial que se acerca',
  'salud, ejercicio o cómo dormiste',
  'una anécdota graciosa del día',
];

const PERSONAS = [
  'Eres una persona curiosa que pregunta y profundiza en las respuestas.',
  'Eres una persona práctica que quiere respuestas breves y concretas.',
  'Eres una persona espontánea que escribe como en WhatsApp.',
  'Eres una persona interesada en cocinar que hace preguntas variadas.',
  'Eres una persona indecisa que necesita aclarar algunas dudas.',
];

// A socket that was closed (paused, destroyed) or never opened.
const clientDead = (client) => !client || client.stopped === true;

const PAUSE_REASON_TEXT = {
  logged_out: 'WhatsApp logged the session out',
  repeated_disconnects: 'too many disconnects',
  manual: 'paused by the user',
};

function describePause(pause) {
  const why = PAUSE_REASON_TEXT[pause.reason] ?? pause.reason;
  return pause.until ? `${why}, until ${pause.until}` : why;
}

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const clock = (ms, timeZone) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

// Age and real incidents for the daily cap. Same function the app uses (session-age.js), refreshed on its
// own schedule whether or not auto pacing is on. Raw disconnects/QR events are not incidents here.
function readAge(id) {
  try {
    return sessionAge({
      session: id,
      events: readEvents(),
      earliestSentSeconds: readActivity(RESULTS_DIR, id, Number.MAX_SAFE_INTEGER).earliestSent,
      now: new Date(),
    });
  } catch {
    return null;
  }
}

function loadTesterConfig() {
  const config = {
    delaySeconds: { min: 20, max: 60 },
    maxMessagesPerTesterPerHour: 40,
    replyTimeoutSeconds: 60,
    replyQuietSeconds: 4,
    ...loadConfig([
      'groupName',
      'botNumber',
      'testers',
      'bot',
    ]),
  };

  config.botNumber = digitsOnly(config.botNumber);

  config.delaySeconds = {
    min: Math.max(1, Number(config.delaySeconds?.min ?? 20)),
    max: Math.max(1, Number(config.delaySeconds?.max ?? 60)),
  };

  if (config.delaySeconds.max < config.delaySeconds.min) {
    [config.delaySeconds.min, config.delaySeconds.max] = [
      config.delaySeconds.max,
      config.delaySeconds.min,
    ];
  }

  config.maxMessagesPerTesterPerHour = Math.max(
    1,
    Number(config.maxMessagesPerTesterPerHour) || 40,
  );

  config.replyTimeoutSeconds = Math.max(
    1,
    Number(config.replyTimeoutSeconds) || 60,
  );

  config.replyQuietSeconds = Math.max(
    1,
    Number(config.replyQuietSeconds) || 4,
  );

  config.autoPacing = normalizeAutoPacing(config.autoPacing);
  // Activity window and daily caps; every field has a default, so an unedited config.json works.
  config.schedule = normalizeSchedule(config.schedule);

  if (!Array.isArray(config.testers) || !config.testers.length) {
    throw new Error('No testers configured in the configuration file.');
  }

  return config;
}

// Minimal async mutex: the returned function runs fn after all queued calls finish.
function createMutex() {
  let tail = Promise.resolve();

  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}

// Sleeps up to ms, returning early once keepGoing() turns false (checked every second).
async function sleepWhile(keepGoing, ms) {
  const end = Date.now() + ms;

  while (keepGoing() && Date.now() < end) {
    await sleep(Math.min(1000, end - Date.now()));
  }
}

function createCsvLog() {
  const dir = RESULTS_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(
    dir,
    `run-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
  );

  const header = [
    'timestamp',
    'turn',
    'tester',
    'topic',
    'sent',
    'replied',
    'latency_ms',
    'reply_count',
    'input_tokens',
    'output_tokens',
    'replies',
    // Appended last so older columns keep their positions.
    'kind',
    'provider',
  ];

  const escape = (value) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;

  fs.writeFileSync(file, `${header.join(',')}\n`, 'utf8');

  return {
    file,
    write(row) {
      fs.appendFileSync(
        file,
        `${header.map((key) => escape(row[key])).join(',')}\n`,
        'utf8',
      );
    },
  };
}

// getGroupId: the group may be resolved after the observer exists (every number paused at start).
function createConversationObserver(getGroupId, botNumber) {
  let botReplyTotal = 0;
  const history = [];

  function remember(author, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const now = Date.now();
    const last = history.at(-1);

    // Avoid recording an identical event twice within a short interval.
    if (
      last &&
      last.author === author &&
      last.text === cleanText &&
      now - last.at < 5000
    ) {
      return;
    }

    history.push({ author, text: cleanText, at: now });

    // Bound memory use during an infinite run.
    if (history.length > 100) history.splice(0, history.length - 100);
  }

  const onMessage = async (msg) => {
    const isVoice = !msg.body?.trim() && isVoiceMessage(msg);
    if (msg.from !== getGroupId() || (!msg.body?.trim() && !isVoice)) return;

    try {
      const authorNumber = digitsOnly(msg.author);
      const author = msg.pushName || authorNumber || 'Participante';

      const text = isVoice
        ? formatVoiceLine(await waitForVoiceTranscript(msg.id?.id))
        : msg.body;

      remember(author, text);

      if (DEBUG) {
        console.log(`[debug] ${author}: ${text}`);
      }

      if (botNumber && authorNumber === botNumber) {
        botReplyTotal++;
      }
    } catch (error) {
      if (DEBUG) {
        console.warn(
          `[debug] Could not inspect group message: ${error?.message || error}`,
        );
      }
    }
  };

  return {
    history,

    // Listens to the group through this client (a paused client is replaced by another live one).
    attach(client) {
      client.on('message', onMessage);
    },

    rememberOwnMessage(author, text) {
      remember(author, text);
    },

    // Total bot messages observed in the group since startup.
    botReplyCount() {
      return botReplyTotal;
    },
  };
}

function buildTesterPrompt(session, persona, topic, history, spoken = false) {
  const recentHistory = history
    .slice(-HISTORY_LIMIT)
    .map((item) => `${item.author}: ${item.text}`)
    .join('\n');

  const format = spoken
    ? [
        'You are about to record a WhatsApp voice note. Write exactly what you would say out loud, in natural spoken Spanish.',
        'Write between 6 and 35 words, as flowing sentences with a conversational rhythm, like someone talking to friends.',
        'Do not use emojis, Markdown, headings, lists, or abbreviations that are awkward to read aloud.',
      ]
    : [
        'Write exactly one natural WhatsApp message in Spanish.',
        'Usually write between 3 and 25 words. Do not use Markdown, headings, or lists.',
        'Use at most one emoji, and only sometimes.',
      ];

  return [
    `You are participating in a WhatsApp group as ${session.id}.`,
    persona,
    `Suggested topic for this turn: ${topic}.`,
    'This is a group of friends chatting casually. There is no store and no bot in the group.',
    ...format,
    'Write in Colombian Spanish. Use "ustedes", never "vosotros" or "os".',
    'Never mention member IDs such as tester3, and do not greet anyone by name.',
    'Do not start with a greeting unless nobody has written yet.',
    'Pay attention to the conversation and respond to what was actually said.',
    'Sometimes ask a follow-up question; sometimes share a short reaction or introduce a related subject.',
    'Vary your wording and subjects. Do not repeat earlier messages.',
    'Speak only for yourself. Do not write messages on behalf of other members.',
    'Return only the message to send, without your name or explanations.',
    '',
    'Recent group conversation, oldest first:',
    recentHistory || '(No previous messages.)',
    '',
    'Write your next message now.',
  ].join('\n');
}

// Returns null when the AI gives nothing sendable; the turn is then skipped.
async function generateTesterMessage(
  ai,
  session,
  persona,
  topic,
  history,
  spoken = false,
) {
  const system =
    'Generate varied, coherent simulated WhatsApp test messages. ' +
    'The conversation is a casual chat between friends.';
  const prompt = buildTesterPrompt(session, persona, topic, history, spoken);

  return generateUsableMessage({
    generate: () =>
      ai.generate({
        system,
        prompt,
        maxTokens: MAX_TOKENS,
      }),
  });
}

// botClient is optional: when run.js passes the already-open bot client, the bot session is
// included in the health report (it never affects any tester's pace).
// Which tester entries a run uses: an explicit list of ids (profiles), the first N (--count),
// or every configured tester. Returns null for "all".
export function testersFromArgs(argv, testers) {
  const { count } = parseRunArgs(argv);
  if (count === null) return null;
  return pickFirst(testers, parseCount(count, testers.length));
}

// testerIds limits the run to those testers (in that order); null/undefined keeps all of them.
// groupName / groupId: the warm-up group of a profile (default: config.groupName). With botClient,
// the bot resolves the group and adds the testers that are not members yet.
export async function runTests({
  loginOnly = false,
  botClient = null,
  testerIds: onlyIds = null,
  groupName: groupNameOption = null,
  groupId: groupIdOption = null,
} = {}) {
  const config = loadTesterConfig();
  const groupName = String(groupNameOption ?? '').trim() || config.groupName;
  // Voices are assigned over every configured tester so a tester keeps its voice in any subset.
  const allTesterIds = testerIds(config.testers);
  if (onlyIds) config.testers = selectTesters(config.testers, onlyIds);
  const ai = createAi({ config, dataDir: DATA_DIR });
  const sessions = [];

  // A tester session. client is null while the number is paused: it is not connected and will be
  // reconnected by its own loop when the pause ends.
  const newSession = (settings, configuredTester, client) => {
    const session = {
      id: settings.id,
      client,
      sentAt: [],
      messagesSent: 0,
      entry: configuredTester,
      baseSettings: settings,
      settings,
      pacingMode: 'off',
      pacingReason: 'auto pacing disabled',
      lastAnalysisAt: null,
      lastFailed: false,
      ready: Promise.resolve(),
      // { days, incidents }: set from the health analysis; until then a rough age from the activity log.
      age: readAge(settings.id),
      ageAt: Date.now(),
      // Group membership must be confirmed before a number that was not connected at start sends.
      needsMembership: !client,
      membershipFailures: 0,
      heldUntil: 0,
      nextReviveAt: 0,
      lastState: null,
    };
    session.gate = createSendGate({
      sessionId: settings.id,
      schedule: config.schedule,
      timezone: resolveTimezone(config.schedule, configuredTester),
      resultsDir: RESULTS_DIR,
      getAge: () => session.age,
    });
    return session;
  };

  try {
    for (const configuredTester of config.testers) {
      const settings = resolveTesterSettings(configuredTester, config);

      if (!settings) continue;

      // A paused number is not connected at all: no socket, no reconnects, no pairing code.
      const pause = pauseStore.get(settings.id);
      if (pause) {
        console.warn(`[${settings.id}] is paused (${describePause(pause)}); it stays disconnected until it is resumed.`);
        sessions.push(newSession(settings, configuredTester, null));
        continue;
      }

      // A session that cannot connect must not take down the whole run:
      // retry once, then skip this tester and keep going with the others.
      let client = null;
      for (let attempt = 1; attempt <= 2 && !client; attempt++) {
        try {
          client = await startClient(settings.id);
        } catch (error) {
          // No phone / codes never entered: retrying right away cannot help, skip this tester for this run.
          // A logged-out number is already paused (and untouched): connecting it again would only repeat the 401.
          if (error?.code === 'NO_PHONE' || error?.code === 'PAIRING_EXPIRED' || error?.code === 'LOGGED_OUT') {
            if (error.code === 'LOGGED_OUT') console.warn(error.message);
            if (error.code === 'PAIRING_EXPIRED') console.warn(error.message);
            break;
          }
          console.warn(`[${settings.id}] failed to start (attempt ${attempt}/2): ${error?.message || error}`);
          if (attempt < 2) await sleep(10_000);
        }
      }

      if (!client && pauseStore.get(settings.id)) {
        sessions.push(newSession(settings, configuredTester, null));
        continue;
      }

      if (!client) {
        console.warn(`[${settings.id}] skipped for this run. Its saved session is kept; it will be retried on the next run.`);
        continue;
      }

      sessions.push(newSession(settings, configuredTester, client));
    }

    if (!sessions.length) {
      throw new Error('No valid tester sessions configured.');
    }

    if (loginOnly) {
      console.log('\nAll tester sessions are linked and saved.');
      return null;
    }

    // The bot is always in the group; a tester might not be (yet), so it must not resolve the group.
    // With every number paused there may be no live client: the id is then resolved when one reconnects.
    const firstLive = () => sessions.find((s) => !clientDead(s.client));
    const resolver = botClient ?? firstLive()?.client ?? null;
    let groupId = groupIdOption ?? (resolver ? await resolveGroupId(resolver, config, { groupName }) : cachedGroupId(config, groupName));

    if (botClient && groupId) {
      const live = sessions.filter((s) => !clientDead(s.client));
      const paused = sessions.filter((s) => clientDead(s.client));
      const { ready, skipped } = await ensureTestersInGroup({ botClient, groupId, groupName, sessions: live });
      sessions.splice(0, sessions.length, ...ready, ...paused);
      if (!sessions.length) {
        throw new Error(
          `No tester is a member of "${groupName}" (skipped: ${skipped.map((s) => s.id).join(', ')}). ` +
            'Add their numbers to the group and run again.',
        );
      }
    }

    const observer = createConversationObserver(() => groupId, config.botNumber);
    let observedClient = null;
    // Listen to the group through one live client; when it is paused, move to another live one.
    const rebindObserver = () => {
      if (observedClient && !clientDead(observedClient)) return;
      const target = firstLive();
      if (!target) return;
      observer.attach(target.client);
      observedClient = target.client;
    };
    rebindObserver();

    const log = createCsvLog();

    console.log(`\nGroup found: ${groupName}`);
    console.log(`Model: ${ai.label}`);
    console.log(`Testers: ${sessions.map((s) => s.id).join(', ')}`);
    const pausedAtStart = sessions.filter((s) => clientDead(s.client)).map((s) => s.id);
    if (pausedAtStart.length) console.log(`Paused (not connected): ${pausedAtStart.join(', ')}`);
    console.log(`Results: ${log.file}`);
    console.log(
      config.schedule.enabled
        ? `[schedule] on: window per number and day (about ${hhmm(config.schedule.start.min)}-${hhmm(config.schedule.start.max)} to ` +
            `${hhmm(config.schedule.end.min)}-${hhmm(config.schedule.end.max)}, ${config.schedule.timezone} unless a tester sets its own), ` +
            `daily caps ${config.schedule.caps.map((c) => c.cap).join('/')} by age.`
        : '[schedule] off (config.schedule.enabled = false): no activity window and no daily cap.',
    );

    // Voice notes: one distinct voice per tester (the bot's voice is kept out of the pool).
    const botVoice = config.bot?.voice || DEFAULT_BOT_VOICE;
    const voices = assignVoices(
      allTesterIds,
      DEFAULT_VOICE_POOL.filter((voice) => voice !== botVoice),
      config.audio?.voices,
    );

    for (const session of sessions) {
      session.audio = audioSettings(config, session.id);
      session.voice = session.audio.voice || voices[session.id];
      const chance = session.voice ? session.audio.chance : 0;
      session.audio = { ...session.audio, chance };
      console.log(
        `[voice] ${session.id}: ${session.voice ?? 'none'}, audio chance ${Math.round(chance * 100)}%` +
          (session.audio.enabled ? '' : ' (audio disabled)'),
      );
    }

    console.log(
      `[voice] ${config.bot?.sessionId || 'bot'}: ${botVoice}, audio chance ` +
        `${Math.round(Math.min(1, Math.max(0, Number(config.bot?.audioChance ?? 0.1))) * 100)}%`,
    );
    console.log('Infinite dynamic mode enabled. Stop with Ctrl+C.\n');

    const stats = {
      sent: 0,
      errors: 0,
    };

    const control = { stopped: false };
    const stop = () => {
      control.stopped = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);

    const autoPacing = config.autoPacing;
    const paceDefaults = {
      delaySeconds: config.delaySeconds,
      maxPerHour: config.maxMessagesPerTesterPerHour,
    };

    // Health analysis of one open client. Never throws: a failure becomes { session, error }.
    // The timeout also cancels the analysis so it stops reading chats in the background.
    // At most MAX_CONCURRENT_ANALYSES run at once (startup launches one per session); the
    // timeout starts when a slot is acquired, not while queued.
    const limitAnalyses = createLimiter(MAX_CONCURRENT_ANALYSES);

    async function analyzeSafely(id, client) {
      return limitAnalyses(async () => {
        const token = { cancelled: false };
        try {
          return await withTimeout(
            analyzeClient(id, client, {
              days: autoPacing.windowDays,
              csvTexts: readCsvTexts(),
              events: readEvents(),
              now: new Date(),
              isStopped: () => control.stopped || token.cancelled,
            }),
            ANALYSIS_TIMEOUT_MS,
            `Health analysis of ${id}`,
          );
        } catch (error) {
          token.cancelled = true;
          const message = String(error?.message || error);
          return fallbackFromReport(id, message) ?? { session: id, error: message };
        }
      });
    }

    // After a failed analysis: reuse the newest health report under 48h old for this session.
    // Incidents are recomputed from the current events. Returns null when there is none.
    function fallbackFromReport(id, message) {
      try {
        const found = accountFromRecentReport(readHealthReports(), id, {
          events: readEvents(),
          now: new Date(),
          windowDays: autoPacing.windowDays,
        });
        if (!found) return null;
        return { ...found.account, fallbackFrom: found.generatedAt, fallbackError: message };
      } catch {
        return null;
      }
    }

    // Applies the pacing policy to a session; returns a log line when its pace changed.
    function applyAnalysis(session, account, history) {
      const trend = account.error || account.fallbackFrom
        ? undefined
        : trendForReport([account], history)[session.id];

      const result = pickPacing({
        entry: session.entry,
        settings: session.baseSettings,
        autoPacing,
        account,
        trend,
        defaults: paceDefaults,
      });

      const before = session.settings;
      session.settings = result.settings;
      session.pacingMode = result.mode;
      session.pacingReason = result.reason;
      session.lastAnalysisAt = Date.now();
      session.lastFailed = Boolean(account.error || account.fallbackFrom);

      account.pacing = {
        mode: result.mode,
        maxPerHour: session.settings.maxPerHour,
        delaySeconds: session.settings.delaySeconds,
        reason: result.reason,
      };

      return describePaceChange(session.id, before, session.settings, result.reason);
    }

    function saveReport(accounts, history, now) {
      // Accounts rebuilt from an old report are not fresh data: saving them would renew their age.
      const fresh = accounts.filter((account) => !account.fallbackFrom);
      if (fresh.length === 0) return;
      try {
        const file = writeHealthReport({
          accounts: fresh,
          history,
          now,
          windowDays: autoPacing.windowDays,
        });
        console.log(`[pacing] health report written to ${file}`);
      } catch (error) {
        console.warn(`[pacing] could not write the health report: ${error?.message || error}`);
      }
    }

    // Re-analyzes one tester between its sends (outside the send mutex) and updates its pace.
    async function recheckSession(session) {
      try {
        const history = readHistory();
        const now = new Date();
        const account = await analyzeSafely(session.id, session.client);
        if (control.stopped) return;

        // Failed with no recent report: keep the current pace and retry within the hour.
        if (account.error) {
          session.lastAnalysisAt = Date.now();
          session.lastFailed = true;
          console.warn(
            `[pacing] ${session.id} recheck failed (${account.error}); keeping current pace ` +
              `${session.settings.maxPerHour}/h, retrying within 1h`,
          );
          saveReport([account], history, now);
          return;
        }

        const change = applyAnalysis(session, account, history);
        console.log(
          change
            ? `[pacing] ${change}`
            : `[pacing] ${session.id} recheck done, pace unchanged: ${session.pacingReason}`,
        );
        saveReport([account], history, now);
      } catch (error) {
        console.warn(`[pacing] ${session.id} recheck failed: ${error?.message || error}`);
        session.lastAnalysisAt = Date.now();
        session.lastFailed = true;
      }
    }

    // Waits for a promise but gives up promptly when the run is stopped.
    async function untilSettledOrStopped(promise) {
      let done = false;
      const settled = promise.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      while (!done && !control.stopped) {
        await Promise.race([settled, sleep(1000)]);
      }
    }

    let analysisSummary = Promise.resolve();

    if (autoPacing.enabled) {
      console.log(
        `Auto pacing enabled: analyzing ${sessions.length} tester(s) with the open sessions ` +
          `(window ${autoPacing.windowDays}d, recheck every ${autoPacing.recheckHours}h). ` +
          'Each tester starts as soon as its own analysis finishes.\n',
      );

      const history = readHistory();
      const startedAt = new Date();

      // One analysis per tester, in parallel; each tester's loop waits only for its own.
      const analyzed = sessions.filter((s) => !clientDead(s.client));
      const analyses = analyzed.map((session) => {
        const promise = (async () => {
          const account = await analyzeSafely(session.id, session.client);
          try {
            const change = applyAnalysis(session, account, history);
            if (change) console.log(`[pacing] ${change}`);
          } catch (error) {
            console.warn(`[pacing] ${session.id} could not apply the pace: ${error?.message || error}`);
          }
          return account;
        })();
        session.ready = promise;
        return promise;
      });

      const botAnalysis = botClient
        ? analyzeSafely(config.bot?.sessionId || 'bot', botClient)
        : Promise.resolve(null);

      analysisSummary = Promise.all([Promise.all(analyses), botAnalysis])
        .then(([accounts, botAccount]) => {
          if (control.stopped) return;

          console.log('\n=== Pacing from health ===');
          console.log(
            formatPacingTable(
              analyzed.map((session, index) => ({
                id: session.id,
                number: accounts[index].number,
                phase: accounts[index].phase?.phase,
                bidirectional: accounts[index].bidirectional,
                incidents: accounts[index].incidents?.total,
                settings: session.settings,
                reason: `[${session.pacingMode}] ${session.pacingReason}`,
              })),
            ),
          );
          console.log('');
          console.log(formatEstimate(estimateRates(sessions.map((s) => s.settings))));
          console.log('');

          saveReport(botAccount ? [botAccount, ...accounts] : accounts, history, startedAt);
        })
        .catch((error) => {
          console.warn(`[pacing] startup summary failed: ${error?.message || error}`);
        });
    } else {
      const estimate = estimateRates(sessions.map((s) => s.settings));
      console.log(formatEstimate(estimate));
    }
    // Paused numbers have no analysis yet; their first recheck runs when they reconnect.

    console.log(
      `Each tester sends on its own schedule (staggered start, up to its max delay).\n`,
    );

    // Serializes "generate + send" so two testers never generate from the same
    // stale history. Sleeps happen outside the lock.
    const lock = createMutex();

    let turn = 0;
    let lastTopic = null;

    async function sendOneMessage(session, persona) {
      return lock(async () => {
        // The number may have been paused while this turn waited for the lock.
        if (clientDead(session.client) || pauseStore.get(session.id)) {
          throw Object.assign(new Error('paused'), { code: 'SESSION_PAUSED' });
        }
        if (!groupId) throw new Error('The warm-up group is not resolved yet.');

        // Avoid picking the same topic twice in a row.
        let topic;
        do {
          topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
        } while (topic === lastTopic && TOPICS.length > 1);
        lastTopic = topic;

        const wantsAudio = shouldSendAudio(session.audio.chance);

        const sentText = await generateTesterMessage(
          ai,
          session,
          persona,
          topic,
          observer.history,
          wantsAudio,
        );

        if (!sentText) {
          throw new Error('The AI gave no usable message; skipping this turn.');
        }

        const sentAt = Date.now();
        let kind = 'text';

        if (wantsAudio) {
          try {
            const ogg = await synthesizeVoiceNote(sentText, session.voice);
            await sendVoiceNote(
              session.client,
              groupId,
              ogg,
              estimateSpeechSeconds(sentText),
              sentText,
            );
            kind = 'voice';
          } catch (error) {
            console.warn(
              `[${session.id}] voice note failed, sending text instead: ${error?.message || error}`,
            );
          }
        }

        if (kind === 'text') {
          await sendLikeHuman(session.client, groupId, sentText);
        }

        session.sentAt.push(sentAt);
        session.messagesSent++;
        session.gate.recordSent();

        // Keep our own outgoing message in the conversation context.
        observer.rememberOwnMessage(
          session.id,
          kind === 'voice' ? `[voice note] ${sentText}` : sentText,
        );

        turn++;
        stats.sent++;

        console.log(
          `\n[turn ${turn}] [${session.id}] [${topic}]${kind === 'voice' ? ' [voice]' : ''} ${sentText}`,
        );

        // Reply columns stay empty on purpose: testers never wait for the bot,
        // so there is no per-message reply to attribute. Bot replies are
        // counted globally by the observer and shown in the [stats] line.
        log.write({
          timestamp: new Date(sentAt).toISOString(),
          turn,
          tester: session.id,
          topic,
          sent: sentText,
          replied: '',
          latency_ms: '',
          reply_count: '',
          input_tokens: 0,
          output_tokens: 0,
          replies: '',
          kind,
          provider: 'local',
        });

        if (stats.sent % 10 === 0) {
          const perTester = sessions
            .map((s) => `${s.id}=${s.messagesSent}`)
            .join(' ');

          console.log(
            `\n[stats] Sent: ${stats.sent} (${perTester}); ` +
            `bot replies seen: ${observer.botReplyCount()}; errors: ${stats.errors}.\n`,
          );
        }
      });
    }

    // A long wait ends early when the run stops or the app pauses this number (Pausar), so a pause
    // takes effect within a second or two instead of after the current pacing delay.
    const stillGoing = (session) => () => !control.stopped && !pauseStore.get(session.id);

    // Logs a state change once (not on every poll).
    function noteState(session, key, text) {
      if (session.lastState === key) return;
      session.lastState = key;
      console.log(`[${session.id}] ${text}`);
    }

    // True when this tester is a member of the warm-up group. The bot (admin) can add it; without a live
    // bot the tester's own view of the member list is used. Anything uncertain counts as "not confirmed".
    async function confirmMembership(session) {
      if (!groupId || clientDead(session.client)) return false;
      try {
        if (botClient && !clientDead(botClient)) {
          const { ready } = await ensureTestersInGroup({ botClient, groupId, groupName, sessions: [session] });
          return ready.length > 0;
        }
        const members = await session.client.groupMembers(groupId);
        const phone = session.client.info?.wid?.user;
        const lid = session.client.info?.wid?.lid;
        return Boolean((phone && members.phones.includes(phone)) || (lid && members.lids.includes(lid)));
      } catch {
        return false;
      }
    }

    // Reconnects a session whose pause ended. Returns true when it is live again. A number that WhatsApp
    // logged out is paused again by startClient itself, so this never loops on a dead session.
    async function reviveSession(session) {
      if (control.stopped || isShuttingDown()) return false;
      try {
        const client = await startClient(session.id);
        session.client = client;
        session.lastAnalysisAt = null; // analyze it again with the live client
        session.needsMembership = true; // it skipped the start-up group check
        if (!groupId) groupId = await resolveGroupId(client, config, { groupName });
        rebindObserver();
        console.log(`[${session.id}] reconnected after its pause.`);
        return true;
      } catch (error) {
        session.nextReviveAt = Date.now() + REVIVE_RETRY_MS;
        console.warn(`[${session.id}] could not reconnect after its pause (${error?.message || error}); retrying in 5 min.`);
        return false;
      }
    }

    // Waits until this tester may send: not paused, connected, inside its window and under its daily cap.
    // Returns null when the run was stopped. Idle waits are short polls that honor stop, never a busy loop.
    async function waitUntilAllowed(session) {
      while (!control.stopped) {
        rebindObserver();

        const pause = pauseStore.get(session.id);
        if (pause) {
          if (!clientDead(session.client)) await stopClient(session.client);
          noteState(session, `paused:${pause.since}`, `paused (${describePause(pause)}); idle until it is resumed.`);
          await sleepWhile(() => !control.stopped, PAUSE_POLL_MS);
          continue;
        }

        if (clientDead(session.client)) {
          if (Date.now() < session.nextReviveAt || !(await reviveSession(session))) {
            await sleepWhile(() => !control.stopped, PAUSE_POLL_MS);
            continue;
          }
        }

        // A number that was not connected at start (or just reconnected) must be in the group before it
        // sends. If that cannot be confirmed it stays out, retrying with a growing wait (5 min up to 1 h).
        if (session.needsMembership) {
          if (Date.now() < session.heldUntil) {
            noteState(session, 'held', 'not confirmed as a member of the group yet; waiting before it checks again.');
            await sleepWhile(() => !control.stopped, PAUSE_POLL_MS);
            continue;
          }
          if (await confirmMembership(session)) {
            session.needsMembership = false;
            session.membershipFailures = 0;
          } else {
            session.heldUntil = Date.now() + backoffMs(session.membershipFailures++, MEMBERSHIP_RETRY_MS, MEMBERSHIP_RETRY_MAX_MS);
            noteState(session, 'held', 'could not confirm it is a member of the group; it will not send and checks again later.');
            continue;
          }
        }

        if (Date.now() - session.ageAt > AGE_REFRESH_MS) {
          session.age = readAge(session.id) ?? session.age;
          session.ageAt = Date.now();
        }

        const gate = session.gate.check();
        if (gate.state === 'active') {
          noteState(session, 'active', `active: ${gate.count}/${gate.cap ?? 'no cap'} messages today${gate.low ? ' (low-activity day)' : ''}.`);
          return gate;
        }

        const opens = gate.nextOpenMs ? clock(gate.nextOpenMs, resolveTimezone(config.schedule, session.entry)) : '?';
        noteState(
          session,
          `${gate.state}:${gate.dateKey}`,
          gate.state === 'capped'
            ? `daily cap reached (${gate.count}/${gate.cap}); idle until ${opens}.`
            : `outside its activity window; idle until ${opens}.`,
        );
        await sleepWhile(() => !control.stopped, Math.min(IDLE_POLL_MS, Math.max(1000, (gate.nextOpenMs ?? 0) - Date.now())));
      }
      return null;
    }

    async function runTesterLoop(session, persona) {
      // Wait only for this tester's own analysis (no-op when auto pacing is off).
      await untilSettledOrStopped(session.ready);

      // Staggered start so the testers do not all fire at once.
      await sleepWhile(
        () => !control.stopped,
        initialOffsetMs(session.settings),
      );

      while (!control.stopped) {
        if (!(await waitUntilAllowed(session))) break;

        if (
          autoPacing.enabled &&
          recheckDue(
            session.lastAnalysisAt,
            Date.now(),
            autoPacing.recheckHours,
            session.lastFailed,
          )
        ) {
          await recheckSession(session);
          if (control.stopped) break;
        }

        try {
          // Wait (outside the lock) if this tester reached its hourly cap.
          const waitMs = hourlyWaitMs(
            session.sentAt,
            Date.now(),
            session.settings.maxPerHour,
          );

          if (waitMs > 0) {
            console.log(
              `[${session.id}] hourly limit reached; pausing about ${Math.ceil(waitMs / 60000)} min`,
            );
            await sleepWhile(stillGoing(session), waitMs);
            session.sentAt = pruneSentAt(session.sentAt);
            if (control.stopped) break;
            // The window, the cap or a pause may have changed while waiting: decide again.
            continue;
          }

          await sendOneMessage(session, persona);
        } catch (error) {
          if (error?.code === 'SESSION_PAUSED') {
            await sleepWhile(() => !control.stopped, 1000);
            continue;
          }

          stats.errors++;

          console.error(
            `[${session.id}] Turn failed: ${error?.message || error}`,
          );

          log.write({
            timestamp: new Date().toISOString(),
            turn,
            tester: session.id,
            topic: '',
            sent: '',
            replied: 'error',
            latency_ms: '',
            reply_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            replies: error?.message || String(error),
            kind: 'text',
          });

          // Avoid a tight retry loop if the API or WhatsApp fails.
          await sleepWhile(() => !control.stopped, 5000);
        }

        // Pace (manual or automatic) and, with a daily cap, spread the rest of the cap over the rest of
        // the window so it is not burned in the morning. Both carry jitter.
        await sleepWhile(
          stillGoing(session),
          Math.max(nextDelayMs(session.settings), session.gate.spreadDelayMs()),
        );
      }
    }

    // One independent loop per tester; a failure in one never stops the others
    // because runTesterLoop catches everything inside its own iteration.
    await Promise.all(
      sessions.map((session, index) => {
        const persona =
          typeof config.testerPersonas?.[session.id] === 'string'
            ? config.testerPersonas[session.id]
            : PERSONAS[index % PERSONAS.length];

        return runTesterLoop(session, persona);
      }).concat(analysisSummary),
    );
  } finally {
    // The infinite loop ends when the process is interrupted.
    // The entry-point handler below closes the sessions.
  }
}

if (isEntryPoint(import.meta.url)) {
  exitCleanlyOnCtrlC();

  Promise.resolve()
    .then(() => {
      const picked = testersFromArgs(process.argv.slice(2), loadTesterConfig().testers);
      return runTests({
        loginOnly: process.argv.includes('--login-only'),
        groupName: parseRunArgs(process.argv.slice(2)).group,
        testerIds: picked && testerIds(picked),
      });
    })
    .catch((error) => {
      console.error(error instanceof SelectionError ? error.message : error?.stack || error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await stopAllClients();
    });
}