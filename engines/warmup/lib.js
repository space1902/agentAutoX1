// Shared helpers: configuration and WhatsApp sessions (Baileys, see wa-client.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import qrcode from 'qrcode-terminal';
import { installConsoleFilter } from './console-filter.js';
import { dataPaths, resolveDataDir } from './data-dir.js';
import { isQrMode, normalizeLinkPhone, parsePhoneHints, persistTesterPhone, resolveLinkPhone } from './link-phone.js';
import { createDisconnectTracker } from './disconnect-brake.js';
import { appendEvent } from './event-log.js';
import { createPauseStore } from './pause-state.js';
import { createSupervisor } from './session-supervisor.js';
import { hasSavedSession } from './session-selection.js';
import { rememberVoiceTranscript } from './voice-transcripts.js';
import { WaClient } from './wa-client.js';
import { isGroupJid, resolveSessionPhone, resolveSessionProxy } from './wa-messages.js';

export {
  formatVoiceLine,
  isVoiceMessage,
  lookupVoiceTranscript,
  rememberVoiceTranscript,
  waitForVoiceTranscript,
} from './voice-transcripts.js';

// Every entry point imports this module: silence libsignal's session-rotation dumps once, early.
installConsoleFilter();

// ROOT is where the code lives; DATA_DIR is where config, profiles, sessions and results live
// (AGENTAUTO_DATA_DIR, default: the original whatsapp-bot-tester folder).
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolveDataDir(ROOT);
const DATA = dataPaths(DATA_DIR);
export const CONFIG_FILE = DATA.configFile;
export const PROFILES_FILE = DATA.profilesFile;
// Variables from the data dir's .env (never overrides what the caller already set).
if (fs.existsSync(DATA.envFile)) process.loadEnvFile(DATA.envFile);
const SETUP_KEYWORD = '#setup';

// One folder per session (Baileys multi-file auth state). Never shared with the old
// whatsapp-web.js sessions, which live in .wwebjs_auth and cannot be reused.
export const AUTH_DIR = DATA.authDir;
export const RESULTS_DIR = DATA.resultsDir;
const EVENTS_FILE = path.join(RESULTS_DIR, 'events.jsonl');

const activeClients = new Set();
// Live client of each session id, so a pause can close the right socket.
const clientsById = new Map();
let shutdownPromise = null;

// Baileys can reject in-flight requests when a socket drops (the session reconnects on its own).
// Report those instead of crashing a long unattended run; anything else keeps the default behaviour.
process.on('unhandledRejection', (reason) => {
  const message = String(reason?.message ?? reason);
  if (/connection (closed|was lost)|timed out/i.test(message)) {
    console.warn(`[session] request dropped with the connection: ${message}`);
    return;
  }
  throw reason;
});

// True once the run is closing its sessions: nothing may reconnect after that.
export const isShuttingDown = () => shutdownPromise !== null;

export async function stopAllClients() {
  if (shutdownPromise) return shutdownPromise;

  const clients = [...activeClients];
  activeClients.clear();
  clientsById.clear();
  shutdownPromise = Promise.allSettled(
    clients.map(async (client) => {
      try {
        await client.destroy();
      } catch (error) {
        console.warn(`[shutdown] could not close a WhatsApp session: ${error?.message || error}`);
      }
    }),
  );

  await shutdownPromise;
  return shutdownPromise;
}

// Append-only session event log (ready / qr / disconnected / auth_failure) used by health.js.
// Logging must never break a run, so every failure is swallowed.
export function logEvent(session, event, detail) {
  appendEvent(EVENTS_FILE, session, event, detail);
}

// Persistent pause state of the numbers (<data dir>/warmup-pauses.json) and the rules that change it.
// A paused number sends nothing and its socket is closed and not reopened until it is resumed.
export const pauseStore = createPauseStore({ file: DATA.pausesFile });

function phoneOf(id) {
  try {
    return resolveSessionPhone(loadConfig(), id);
  } catch {
    return null;
  }
}

export const supervisor = createSupervisor({
  store: pauseStore,
  tracker: createDisconnectTracker(),
  fleetSize: () => activeClients.size,
  logEvent,
  stopSession: (id) => {
    const client = clientsById.get(id);
    if (client) void stopClient(client);
  },
  numberOf: phoneOf,
});

// Heartbeat (to notice a frozen process) and periodic sweep (timed pauses end, the brake is judged).
let backgroundTimers = false;
function ensureBackgroundTimers() {
  if (backgroundTimers) return;
  backgroundTimers = true;
  supervisor.beat();
  setInterval(() => supervisor.beat(), 10_000).unref();
  setInterval(() => supervisor.sweep(), 60_000).unref();
}

export function readEvents() {
  try {
    return fs
      .readFileSync(EVENTS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// Close one session early (health.js opens them one at a time to save memory).
export async function stopClient(client) {
  activeClients.delete(client);
  for (const [id, current] of clientsById) if (current === client) clientsById.delete(id);
  try {
    await client.destroy();
  } catch (error) {
    console.warn(`[shutdown] could not close a WhatsApp session: ${error?.message || error}`);
  }
}

export const isEntryPoint = (moduleUrl) =>
  pathToFileURL(process.argv[1] ?? '').href === moduleUrl;

export function exitCleanlyOnCtrlC() {
  let stopping = false;

  process.once('SIGINT', async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nCtrl+C received. Stopping all WhatsApp sessions...');
    await stopAllClients();
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nSIGTERM received. Stopping all WhatsApp sessions...');
    await stopAllClients();
    process.exit(0);
  });

  // Ctrl+Break (SIGBREAK on Windows): how the agentAutoX1 desktop app asks a hidden profile run to stop.
  process.once('SIGBREAK', async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStop requested. Stopping all WhatsApp sessions...');
    await stopAllClients();
    process.exit(0);
  });

  // Closing the terminal window sends SIGHUP on Windows; save the sessions before it closes.
  process.once('SIGHUP', async () => {
    if (stopping) return;
    stopping = true;
    await stopAllClients();
    process.exit(0);
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const randomBetween = (min, max) => min + Math.random() * (max - min);
export const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function loadConfig(requiredKeys = []) {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('Missing config.json. Copy config.example.json to config.json and edit it.');
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

  for (const key of requiredKeys) {
    const value = config[key];
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      throw new Error(`config.json is missing "${key}"`);
    }
  }

  return config;
}

// Pairing codes (or failed requests) allowed per session and run before giving up; each code lasts a
// couple of minutes, so this leaves the user several minutes to type one.
const MAX_PAIRING_ATTEMPTS = 5;

function noPhoneError(id) {
  return Object.assign(
    new Error(`[${id}] needs a phone number to link by code: set it in the app (Editar instancia / Números)`),
    { code: 'NO_PHONE' },
  );
}

// Linking is ALWAYS by pairing code. The phone comes from (in order) config.json, the session, the newest
// logged-out/unlinked backup, or LINK_PHONES (set by the app). With no phone the session is not started and
// no QR is shown. LINK_MODE=qr is a hidden escape hatch that restores the old QR flow.
// Options are for tests: authRoot (sessions folder), clientFactory (replaces WaClient), config, hints,
// linkMode, persistPhone and maxPairingAttempts.
export function startClient(
  id,
  {
    authRoot = AUTH_DIR,
    clientFactory = (options) => new WaClient(options),
    config = null,
    hints = parsePhoneHints(process.env.LINK_PHONES),
    linkMode = process.env.LINK_MODE,
    persistPhone = (args) => persistTesterPhone({ configFile: CONFIG_FILE, ...args }),
    maxPairingAttempts = MAX_PAIRING_ATTEMPTS,
    supervisor: rules = supervisor,
  } = {},
) {
  ensureBackgroundTimers();
  // Only a session that was really linked can be "logged out"; an unlinked one needs a pairing code.
  const wasLinked = hasSavedSession(authRoot, id);
  const qrMode = isQrMode(linkMode);

  let currentConfig = config;
  if (!currentConfig) {
    try {
      currentConfig = loadConfig();
    } catch {
      currentConfig = {};
    }
  }

  let phone;
  if (qrMode) {
    phone = normalizeLinkPhone(resolveSessionPhone(currentConfig, id));
  } else {
    const resolved = resolveLinkPhone({ config: currentConfig, id, authRoot, hints });
    phone = resolved.phone;
    if (!phone && !wasLinked) {
      console.error(noPhoneError(id).message);
      return Promise.reject(noPhoneError(id));
    }
    if (phone && !wasLinked && resolved.source !== 'config') {
      // Written by this same process (synchronous read-modify-write), so it cannot race the engine's own config writes.
      const outcome = persistPhone({ id, phone });
      if (outcome?.status === 'saved') {
        console.log(`[${id}] saved +${phone} (from its ${resolved.source}) to config.json.`);
      } else if (outcome?.status === 'duplicate') {
        console.warn(`[${id}] +${phone} is already used by "${outcome.owner}" in config.json; not saving it for this tester.`);
      } else if (outcome && !['has-phone', 'not-in-config'].includes(outcome.status)) {
        console.warn(`[${id}] could not save +${phone} to config.json (${outcome.error ?? outcome.status}).`);
      }
    }
  }

  const client = clientFactory({
    id,
    authDir: path.join(authRoot, id),
    activityDir: RESULTS_DIR,
    proxy: resolveSessionProxy(currentConfig, id),
    phone,
    qrFallback: qrMode,
  });

  activeClients.add(client);
  clientsById.set(id, client);

  return new Promise((resolve, reject) => {
    let settled = false;
    let isReady = false;

    const stuckWarning = setTimeout(() => {
      console.warn(
        `[${id}] still starting after 90s. Close other runs using ".baileys_auth/${id}", then try again.`,
      );
    }, 90_000);

    // Give up after 3 minutes (unless a QR is waiting to be scanned) so the caller can retry
    // or skip this session.
    const stuckFail = setTimeout(() => {
      fail(new Error(`[${id}] WhatsApp did not connect within 3 minutes`));
    }, 180_000);

    const cleanupTimers = () => {
      clearTimeout(stuckWarning);
      clearTimeout(stuckFail);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      activeClients.delete(client);
      if (clientsById.get(id) === client) clientsById.delete(id);
      withTimeout(client.destroy(), 15_000, 'Closing a stuck session')
        .catch(() => {})
        .finally(() => reject(error));
    };

    let qrLogged = false;
    // A QR or pairing code means the saved session was lost; log it once even if the code rotates.
    const noteLinkingPrompt = () => {
      cleanupTimers();
      if (!qrLogged) {
        qrLogged = true;
        logEvent(id, 'qr');
      }
    };

    // Codes expire (WhatsApp closes the socket and the client asks for a new one); keep going up to a limit.
    let attempts = 0;
    let lastWasCode = false;
    const giveUpIfExhausted = () => {
      if (attempts <= maxPairingAttempts) return false;
      fail(
        Object.assign(
          new Error(
            `[${id}] pairing code expired ${maxPairingAttempts} times without being entered; ` +
              'giving up on this number for this run.',
          ),
          { code: 'PAIRING_EXPIRED' },
        ),
      );
      return true;
    };

    client.on('pairing_code', (code) => {
      if (settled) return;
      attempts++;
      if (giveUpIfExhausted()) return;
      noteLinkingPrompt();
      if (lastWasCode) {
        console.log(`[${id}] Pairing code expired; requested a new one (${attempts}/${maxPairingAttempts})`);
      }
      lastWasCode = true;
      console.log(`
[${id}] Pairing code: ${code}`);
      console.log(
        `On the phone for "${id}" (+${client.phone}): WhatsApp > Linked devices > Link a device > ` +
          'Link with phone number instead, then type the code.',
      );
    });

    client.on('pairing_failed', (error) => {
      if (settled) return;
      attempts++;
      lastWasCode = false;
      if (giveUpIfExhausted()) return;
      console.warn(
        `[${id}] could not get a pairing code (${error?.message || error}); ` +
          `trying again (${attempts}/${maxPairingAttempts})`,
      );
    });

    client.on('qr', (qr) => {
      noteLinkingPrompt();
      console.log(`
[${id}] Scan this QR from WhatsApp > Linked devices on the phone for "${id}":`);
      qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
      // Baileys reports "ready" again after every automatic reconnect; only the first one counts.
      if (settled || isReady) return;
      settled = true;
      isReady = true;
      cleanupTimers();
      console.log(`[${id}] ready`);
      logEvent(id, 'ready');
      rules.markStarted(id);
      resolve(client);
    });

    client.on('disconnected', (reason) => {
      console.warn(`[${id}] disconnected: ${reason}`);
      logEvent(id, 'disconnected', reason);
      // LOGOUT is handled by 'logged_out'; CONFLICT and FATAL do not reconnect, so they are not flapping.
      if (!/^(LOGOUT|CONFLICT|FATAL)/.test(String(reason))) rules.onDisconnect(id, String(reason));
    });

    client.on('logged_out', () => {
      // WhatsApp ended this session. The number is paused until a human resumes it: nothing is archived,
      // deleted or linked again automatically, and no QR or pairing code is requested.
      if (wasLinked || isReady) rules.onLoggedOut(id);
      if (isReady) return;

      fail(
        Object.assign(
          new Error(
            wasLinked
              ? `[${id}] WhatsApp logged this number out. It is paused and its saved session was left untouched. ` +
                  'Link it again yourself, then resume it.'
              : `[${id}] WhatsApp logged this number out before it was linked. Link it again with a pairing code.`,
          ),
          { code: 'LOGGED_OUT' },
        ),
      );
    });

    client.on('fatal', (reason) => {
      if (isReady) return;
      fail(
        new Error(
          reason === 'CONFLICT'
            ? `[${id}] this session is in use by another run (usually run.js). ` +
                'Stop it with a single Ctrl+C, wait for it to close, then run the command again.'
            : `[${id}] WhatsApp closed the connection (${reason}). Run the command again; if it repeats, ` +
                `delete ".baileys_auth\\${id}" and link it again with a pairing code.`,
        ),
      );
    });

    client.connect().catch(fail);
  });
}

export async function findGroup(client, groupName) {
  const groups = await client.listGroups();
  const wanted = groupName.trim().toLowerCase();
  const group = groups.find((item) => item.name.trim().toLowerCase() === wanted);

  if (!group) {
    const names = groups.map((item) => `  - ${item.name}`).join('\n') || '  (none)';
    throw new Error(
      `Group "${groupName}" not found. The bot number must be a member (and admin) of it. ` +
        `Groups visible to this session:\n${names}`,
    );
  }

  return group.id;
}

const groupKey = (name) => String(name ?? '').trim().toLowerCase();

// Cached group id: config.groupIds["<name lowercased>"], or the legacy config.groupId when the
// name is config.groupName (the default group). null when this group was never resolved.
export function cachedGroupId(config, groupName) {
  const key = groupKey(groupName);
  if (!key) return null;
  if (config.groupIds?.[key]) return config.groupIds[key];
  if (key === groupKey(config.groupName) && config.groupId) return config.groupId;
  return null;
}

// New config with the id cached for that group; the default group also keeps the legacy groupId.
export function withGroupId(config, groupName, groupId) {
  const key = groupKey(groupName);
  const next = { ...config, groupIds: { ...config.groupIds, [key]: groupId } };
  if (key === groupKey(config.groupName)) next.groupId = groupId;
  return next;
}

function saveGroupId(groupName, groupId) {
  const config = withGroupId(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), groupName, groupId);
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`Saved the id of group "${groupName}" to config.json; next runs will skip this step.`);
}

function waitForSetupMessage(client) {
  return new Promise((resolve) => {
    const onMessage = (msg) => {
      if (msg.body?.trim().toLowerCase() !== SETUP_KEYWORD) return;
      if (!isGroupJid(msg.from)) return;

      client.removeListener('message_create', onMessage);
      resolve(msg.from);
    };

    client.on('message_create', onMessage);
  });
}

// groupName: the warm-up group to use (a profile's group); defaults to config.groupName.
// save is for tests: where the resolved id is persisted.
export async function resolveGroupId(
  client,
  config,
  { groupName = config.groupName, save = saveGroupId } = {},
) {
  const cached = cachedGroupId(config, groupName);
  if (cached) return cached;

  try {
    const groupId = await withTimeout(
      findGroup(client, groupName),
      45_000,
      'Listing chats',
    );
    save(groupName, groupId);
    return groupId;
  } catch (error) {
    if (error.message.startsWith('Group "')) throw error;
    console.warn(`Could not read the chat list (${error.message}).`);
  }

  console.log(`\n>>> From any phone, send ${SETUP_KEYWORD} in the group "${groupName}". Waiting...`);
  const groupId = await waitForSetupMessage(client);
  save(groupName, groupId);
  return groupId;
}

export async function sendLikeHuman(client, groupId, text, maxTypingMs = 4000) {
  try {
    await withTimeout(client.setPresence(groupId, 'composing'), 15_000, 'Sending typing state');
  } catch {
    // Typing indicator is cosmetic; send the message anyway.
  }

  await sleep(Math.min(maxTypingMs, 800 + String(text).length * 50));
  await client.sendText(groupId, text);
}

// Sends an OGG/Opus buffer as a WhatsApp voice note (push-to-talk style), showing the
// "recording audio" state for a pause proportional to the clip length. Returns the sent message
// and registers `transcript` so other sessions in this process can read it.
export async function sendVoiceNote(client, groupId, oggBuffer, approxSeconds = 5, transcript = '', maxRecordingMs = 12_000) {
  try {
    await withTimeout(client.setPresence(groupId, 'recording'), 15_000, 'Sending recording state');
  } catch {
    // The recording indicator is cosmetic; send the voice note anyway.
  }

  await sleep(Math.min(maxRecordingMs, 1000 + Math.max(0, Number(approxSeconds) || 0) * 600));

  const sent = await client.sendVoice(groupId, oggBuffer);
  // Receivers in this process look the text up by the inner id (same on every device).
  rememberVoiceTranscript(sent?.id?.id, transcript);
  return sent;
}
