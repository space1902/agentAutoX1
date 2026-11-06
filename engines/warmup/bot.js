// Runs the bot session: listens to the test group and answers with the local model (Ollama).
// Messages arriving while the model is writing are grouped into one reply.
import {
  cachedGroupId,
  exitCleanlyOnCtrlC,
  isEntryPoint,
  isShuttingDown,
  DATA_DIR,
  RESULTS_DIR,
  loadConfig,
  pauseStore,
  randomBetween,
  resolveGroupId,
  formatVoiceLine,
  isVoiceMessage,
  sendLikeHuman,
  sendVoiceNote,
  sleep,
  startClient,
  stopClient,
  waitForVoiceTranscript,
} from './lib.js';
import { normalizeSchedule, resolveTimezone } from './activity-schedule.js';
import { createBotWatcher } from './bot-watcher.js';
import { createSendGate } from './send-gate.js';
import { parseRunArgs } from './session-selection.js';
import {
  DEFAULT_BOT_VOICE,
  estimateSpeechSeconds,
  shouldSendAudio,
  synthesizeVoiceNote,
} from './voice.js';
import { createAi } from './ai-provider.js';
import { generateUsableMessage } from './local-model.js';

const DEFAULT_BOT = {
  sessionId: 'bot',
  displayName: 'Bot',
  historySize: 20,
  replyDelaySeconds: { min: 3, max: 10 },
  // Probability of answering a batch of messages; a real member does not reply to everything.
  replyChance: 0.7,
  // Probability that a reply is sent as a voice note (free Edge neural TTS) instead of text.
  audioChance: 0.1,
  voice: DEFAULT_BOT_VOICE,
  persona: 'You are a regular member of a group of friends on WhatsApp.',
};

function loadBotConfig() {
  const config = loadConfig(['groupName']);
  const bot = { ...DEFAULT_BOT, ...config.bot };
  bot.replyDelaySeconds = {
    ...DEFAULT_BOT.replyDelaySeconds,
    ...config.bot?.replyDelaySeconds,
  };
  bot.historySize = Math.max(1, Number(bot.historySize) || DEFAULT_BOT.historySize);
  bot.replyChance = Math.min(1, Math.max(0, Number(bot.replyChance ?? DEFAULT_BOT.replyChance)));
  bot.audioChance = Math.min(1, Math.max(0, Number(bot.audioChance ?? DEFAULT_BOT.audioChance) || 0));
  bot.voice = String(bot.voice || DEFAULT_BOT.voice).trim();
  if (config.audio?.enabled === false) bot.audioChance = 0;
  // Same activity window and daily-cap rules as the testers (bot cap: schedule.botDailyCap, default 150).
  const schedule = normalizeSchedule(config.schedule);
  return { config, bot, schedule };
}

function buildSystemPrompt(bot) {
  return [
    bot.persona,
    'You are taking part in a WhatsApp group chat. You will receive recent group messages, oldest first, each prefixed with the sender name. Write only your next message to the group.',
    'Reply in the same language the group is using; in Spanish, write like a Colombian and use "ustedes", never "vosotros" or "os". Keep it short and conversational, like a real WhatsApp message: one to three sentences, no markdown, no bullet lists, no headings.',
    'If several people wrote, answer them in a single message and address each by name when it helps.',
    'You are a person, not an assistant or a bot. Never say you are an AI, never offer help like a service would, and do not end every message with a question. Share your own opinions, plans and small stories, and follow the flow of the conversation.',
  ].join('\n\n');
}

// A paused bot keeps its socket closed and is checked again this often (Reanudar takes effect within it).
const BOT_POLL_MS = 15_000;
const REVIVE_RETRY_MS = 5 * 60_000;

const SPOKEN_INSTRUCTION =
  'You are about to record this as a WhatsApp voice note: write exactly what you would say out loud, ' +
  'in natural spoken language, 6 to 35 words, with no emojis, lists or markdown.';

// Returns null when the AI gives nothing sendable; the bot then stays quiet.
async function generateReply(ai, bot, systemPrompt, history, spoken = false) {
  const prompt =
    `Latest group messages:\n${history.join('\n')}\n\n` +
    `Write your next message as ${bot.displayName}.` +
    (spoken ? `\n${SPOKEN_INSTRUCTION}` : '');

  return generateUsableMessage({
    generate: () =>
      ai.generate({
        system: systemPrompt,
        prompt,
        maxTokens: 300,
      }),
  });
}

// groupName: the warm-up group to talk in (a profile's group); defaults to config.groupName.
// Resolves with { client, groupId, groupName } so the testers can reuse the group the bot found.
// client is null when the bot number is paused: testers keep working without it, and the bot reconnects
// by itself when it is resumed.
export async function startBotSession({ groupName: groupNameOption = null } = {}) {
  const { config, bot, schedule } = loadBotConfig();
  const groupName = String(groupNameOption ?? '').trim() || config.groupName;
  const ai = createAi({ config, dataDir: DATA_DIR });
  const systemPrompt = buildSystemPrompt(bot);
  const gate = createSendGate({
    sessionId: bot.sessionId,
    schedule,
    timezone: resolveTimezone(schedule, { timezone: bot.timezone }),
    resultsDir: RESULTS_DIR,
    flatCap: schedule.botDailyCap,
  });

  let client = null;
  let groupId = cachedGroupId(config, groupName);
  let lastQuiet = null;

  const history = [];
  const remember = (line) => {
    history.push(line);
    while (history.length > bot.historySize) history.shift();
  };

  let pending = [];
  let busy = false;

  // Why the bot must not reply right now, or null when it may.
  function quietReason() {
    const pause = pauseStore.get(bot.sessionId);
    if (pause) return `paused (${pause.reason})`;
    if (!client || client.stopped) return 'not connected';
    const status = gate.check();
    if (status.state === 'capped') return `daily cap reached (${status.count}/${status.cap})`;
    if (status.state === 'outside_window') return 'outside its activity window';
    return null;
  }

  async function processQueue() {
    if (busy) return;
    busy = true;

    try {
      while (pending.length) {
        await sleep(
          randomBetween(bot.replyDelaySeconds.min, bot.replyDelaySeconds.max) * 1000,
        );

        const batch = pending;
        pending = [];
        for (const item of batch) remember(`${item.name}: ${item.text}`);

        // Paused, out of hours or at its daily cap: keep reading the group, say nothing.
        const quiet = quietReason();
        if (quiet) {
          if (lastQuiet !== quiet) console.log(`[bot] staying quiet: ${quiet}`);
          lastQuiet = quiet;
          continue;
        }
        lastQuiet = null;

        if (Math.random() > bot.replyChance) {
          console.log('[bot] skipping this turn, like a person who just reads');
          continue;
        }

        try {
          const wantsAudio = shouldSendAudio(bot.audioChance);
          const reply = await generateReply(ai, bot, systemPrompt, history, wantsAudio);
          if (!reply) {
            console.warn('[bot] local model gave no usable reply; staying quiet this turn');
            continue;
          }

          let sentAsVoice = false;
          if (wantsAudio) {
            try {
              const ogg = await synthesizeVoiceNote(reply, bot.voice);
              await sendVoiceNote(client, groupId, ogg, estimateSpeechSeconds(reply), reply);
              sentAsVoice = true;
            } catch (error) {
              console.warn(`[bot] voice note failed, sending text instead: ${error?.message || error}`);
            }
          }

          if (!sentAsVoice) await sendLikeHuman(client, groupId, reply, 6000);
          gate.recordSent();
          remember(`${bot.displayName}: ${sentAsVoice ? '[voice note] ' : ''}${reply}`);
          console.log(`[bot] -> ${sentAsVoice ? '[voice] ' : ''}${reply}`);
        } catch (error) {
          console.error(`[bot] failed to reply: ${error?.message || error}`);
        }
      }
    } finally {
      busy = false;
      // Guard against messages arriving right as the queue is finishing.
      if (pending.length) void processQueue();
    }
  }

  function listen(live) {
    live.on('message', async (msg) => {
      const isVoice = !msg.body?.trim() && isVoiceMessage(msg);
      if (msg.from !== groupId || (!msg.body?.trim() && !isVoice)) return;

      try {
        const name = msg.pushName || msg.author || 'Someone';

        const text = isVoice
          ? formatVoiceLine(await waitForVoiceTranscript(msg.id?.id))
          : msg.body.trim();

        console.log(`[bot] <- ${name}: ${text}`);
        pending.push({ name, text });
        if (!busy) void processQueue();
      } catch (error) {
        console.error(`[bot] could not process incoming message: ${error?.message || error}`);
      }
    });
  }

  async function connect() {
    const live = await startClient(bot.sessionId);
    try {
      groupId = await resolveGroupId(live, config, { groupName });
      listen(live);
    } catch (error) {
      await stopClient(live);
      throw error;
    }
    client = live;
    console.log(`[bot] listening in "${groupName}" with ${ai.label}`);
    console.log(`[voice] ${bot.sessionId}: ${bot.voice}, audio chance ${Math.round(bot.audioChance * 100)}%`);
  }

  const pausedAtStart = pauseStore.get(bot.sessionId);
  if (pausedAtStart) {
    console.warn(`[bot] is paused (${pausedAtStart.reason}); it stays disconnected and the testers go on without it.`);
  } else {
    try {
      await connect();
    } catch (error) {
      // A logged-out bot is paused and untouched (see lib.js); anything else stops the run as before.
      if (error?.code !== 'LOGGED_OUT') throw error;
      console.warn(error.message);
    }
  }

  // Keeps the bot's connection in line with its pause state: closes it while paused, reopens it when resumed.
  const botWatcher = createBotWatcher({
    isPaused: () => Boolean(pauseStore.get(bot.sessionId)),
    isShuttingDown,
    getClient: () => client,
    stopClient,
    connect: async () => {
      await connect();
      console.log('[bot] reconnected after its pause.');
    },
    retryMs: REVIVE_RETRY_MS,
  });
  // One connect at a time: a tick that finds the previous connect still pending does nothing.
  const watcher = setInterval(() => void botWatcher.tick(), BOT_POLL_MS);
  watcher.unref();

  return { client, groupId, groupName };
}

export async function startBot(options) {
  return (await startBotSession(options)).client;
}

if (isEntryPoint(import.meta.url)) {
  exitCleanlyOnCtrlC();
  // A paused bot has no socket to keep the process alive; this keeps it running until Ctrl+C.
  const keepAlive = setInterval(() => {}, 2 ** 30);
  startBot({ groupName: parseRunArgs(process.argv.slice(2)).group }).catch((error) => {
    clearInterval(keepAlive);
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
