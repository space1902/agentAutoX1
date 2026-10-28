
import fs from 'node:fs';
import path from 'node:path';

import {
  generateLocal,
  generateUsableMessage,
  resolveLocalModel,
} from './local-model.js';
import {
  RESULTS_DIR,
  digitsOnly,
  exitCleanlyOnCtrlC,
  formatVoiceLine,
  isEntryPoint,
  isVoiceMessage,
  loadConfig,
  readEvents,
  resolveGroupId,
  sendLikeHuman,
  sendVoiceNote,
  sleep,
  startClient,
  stopAllClients,
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
import {
  describePaceChange,
  estimateRates,
  formatEstimate,
  formatPacingTable,
  hourlyWaitMs,
  initialOffsetMs,
  nextDelayMs,
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

function createConversationObserver(observer, groupId, botNumber) {
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

  observer.on('message', async (msg) => {
    const isVoice = !msg.body?.trim() && isVoiceMessage(msg);
    if (msg.from !== groupId || (!msg.body?.trim() && !isVoice)) return;

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
  });

  return {
    history,

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

// Returns null when the local model gives nothing sendable; the turn is then skipped.
async function generateTesterMessage(
  localModel,
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
      generateLocal({
        url: localModel.url,
        model: localModel.model,
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
  const localModel = resolveLocalModel(config);
  const sessions = [];

  try {
    for (const configuredTester of config.testers) {
      const settings = resolveTesterSettings(configuredTester, config);

      if (!settings) continue;

      // A session that cannot connect must not take down the whole run:
      // retry once, then skip this tester and keep going with the others.
      let client = null;
      for (let attempt = 1; attempt <= 2 && !client; attempt++) {
        try {
          client = await startClient(settings.id);
        } catch (error) {
          console.warn(`[${settings.id}] failed to start (attempt ${attempt}/2): ${error?.message || error}`);
          if (attempt < 2) await sleep(10_000);
        }
      }

      if (!client) {
        console.warn(`[${settings.id}] skipped for this run. Its saved session is kept; it will be retried on the next run.`);
        continue;
      }

      sessions.push({
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
      });
    }

    if (!sessions.length) {
      throw new Error('No valid tester sessions configured.');
    }

    if (loginOnly) {
      console.log('\nAll tester sessions are linked and saved.');
      return null;
    }

    // The bot is always in the group; a tester might not be (yet), so it must not resolve the group.
    const groupId = groupIdOption ?? (await resolveGroupId(botClient ?? sessions[0].client, config, { groupName }));

    if (botClient) {
      const { ready, skipped } = await ensureTestersInGroup({ botClient, groupId, groupName, sessions });
      sessions.splice(0, sessions.length, ...ready);
      if (!sessions.length) {
        throw new Error(
          `No tester is a member of "${groupName}" (skipped: ${skipped.map((s) => s.id).join(', ')}). ` +
            'Add their numbers to the group and run again.',
        );
      }
    }

    const observer = createConversationObserver(
      sessions[0].client,
      groupId,
      config.botNumber,
    );

    const log = createCsvLog();

    console.log(`\nGroup found: ${groupName}`);
    console.log(`Model: ${localModel.model} (local, Ollama; no paid API)`);
    console.log(`Testers: ${sessions.map((s) => s.id).join(', ')}`);
    console.log(`Results: ${log.file}`);

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
      const analyses = sessions.map((session) => {
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
              sessions.map((session, index) => ({
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
        // Avoid picking the same topic twice in a row.
        let topic;
        do {
          topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
        } while (topic === lastTopic && TOPICS.length > 1);
        lastTopic = topic;

        const wantsAudio = shouldSendAudio(session.audio.chance);

        const sentText = await generateTesterMessage(
          localModel,
          session,
          persona,
          topic,
          observer.history,
          wantsAudio,
        );

        if (!sentText) {
          throw new Error('The local model gave no usable message; skipping this turn.');
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

    async function runTesterLoop(session, persona) {
      // Wait only for this tester's own analysis (no-op when auto pacing is off).
      await untilSettledOrStopped(session.ready);

      // Staggered start so the testers do not all fire at once.
      await sleepWhile(
        () => !control.stopped,
        initialOffsetMs(session.settings),
      );

      while (!control.stopped) {
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
            await sleepWhile(() => !control.stopped, waitMs);
            session.sentAt = pruneSentAt(session.sentAt);
            if (control.stopped) break;
          }

          await sendOneMessage(session, persona);
        } catch (error) {
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

        await sleepWhile(
          () => !control.stopped,
          nextDelayMs(session.settings),
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