// Shared helpers: configuration and WhatsApp sessions (Baileys, see wa-client.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import qrcode from 'qrcode-terminal';
import { installConsoleFilter } from './console-filter.js';
import { dataPaths, resolveDataDir } from './data-dir.js';
import { archiveLoggedOutSession } from './session-archive.js';
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
// Sessions already relinked after a logout in this run (only one automatic relink per session).
const relinkedThisRun = new Set();
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

export async function stopAllClients() {
  if (shutdownPromise) return shutdownPromise;

  const clients = [...activeClients];
  activeClients.clear();
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
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    const entry = { at: new Date().toISOString(), session, event };
    if (detail !== undefined && detail !== null) entry.detail = String(detail);
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Ignore: the event log is best effort.
  }
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

// Optional per-session proxy from config.json (bot.proxy, or "proxy" in a tester entry).
function sessionProxy(id) {
  try {
    return resolveSessionProxy(loadConfig(), id);
  } catch {
    return null;
  }
}

// Optional per-session phone number: when set, unlinked sessions use a pairing code instead of a QR.
function sessionPhone(id) {
  try {
    return resolveSessionPhone(loadConfig(), id);
  } catch {
    return null;
  }
}

// Options are for tests: authRoot (sessions folder) and clientFactory (replaces WaClient).
export function startClient(id, { authRoot = AUTH_DIR, clientFactory = (options) => new WaClient(options) } = {}) {
  // Only a session that was really linked can be "logged out"; an unlinked one just shows a QR.
  const wasLinked = hasSavedSession(authRoot, id);
  const client = clientFactory({
    id,
    authDir: path.join(authRoot, id),
    activityDir: RESULTS_DIR,
    proxy: sessionProxy(id),
    phone: sessionPhone(id),
  });

  activeClients.add(client);

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

    client.on('pairing_code', (code) => {
      noteLinkingPrompt();
      console.log(`
[${id}] Pairing code: ${code}`);
      console.log(
        `On the phone for "${id}" (+${client.phone}): WhatsApp > Linked devices > Link a device > ` +
          'Link with phone number instead, then type the code.',
      );
    });

    client.on('qr', (qr) => {
      noteLinkingPrompt();
      console.log(`\n[${id}] Scan this QR from WhatsApp > Linked devices on the phone for "${id}":`);
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
      resolve(client);
    });

    client.on('disconnected', (reason) => {
      console.warn(`[${id}] disconnected: ${reason}`);
      logEvent(id, 'disconnected', reason);
    });

    client.on('logged_out', () => {
      if (isReady) return;

      if (wasLinked && !relinkedThisRun.has(id) && !settled) {
        // WhatsApp ended this session: keep it in _logged_out and link the number again from scratch.
        relinkedThisRun.add(id);
        settled = true;
        cleanupTimers();
        activeClients.delete(client);
        withTimeout(client.destroy(), 15_000, 'Closing a logged-out session')
          .catch(() => {})
          .then(() => {
            const archived = archiveLoggedOutSession(authRoot, id);
            console.warn(
              `[${id}] WhatsApp logged this session out; it was moved to ${archived ?? '(nothing to move)'} ` +
                'and the number will be linked again.',
            );
            logEvent(id, 'logged_out_relink');
            return startClient(id, { authRoot, clientFactory });
          })
          .then(resolve, reject);
        return;
      }

      fail(
        new Error(
          `[${id}] WhatsApp logged this number out. Close this run, delete ".baileys_auth\\${id}", ` +
            `remove old entries in WhatsApp > Linked devices on that phone, and scan a new QR.`,
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
                `delete ".baileys_auth\\${id}" and scan a new QR.`,
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
