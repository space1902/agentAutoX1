// Pure helpers for the Baileys connection layer (no I/O, no Baileys import), so they are unit-tested.
// They translate Baileys' raw objects into the small message shape the bots already use:
//   { id: { id }, from, author, pushName, fromMe, body, type, hasMedia, timestamp }
export const VOICE_MIMETYPE = 'audio/ogg; codecs=opus';

const USER_SERVER = '@s.whatsapp.net';
const WAVEFORM_SAMPLES = 64;

export const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

// Phone number or JID -> JID. Existing JIDs (users and groups) pass through untouched.
export function toJid(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.includes('@')) return text;
  const digits = digitsOf(text);
  return digits ? `${digits}${USER_SERVER}` : '';
}

export const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

// Phone number behind a phone JID ("57300...:12@s.whatsapp.net" -> "57300..."). LIDs and groups
// carry no phone number, so they return ''.
export function jidDigits(jid) {
  if (typeof jid !== 'string' || !jid.endsWith(USER_SERVER)) return '';
  return digitsOf(jid.split('@')[0].split(':')[0]);
}

// Number part of a LID ("2087654321:12@lid" -> "2087654321"). Not a phone number: only useful to
// compare against LIDs that WhatsApp reports for the same account. Anything else returns ''.
export function lidDigits(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@lid')) return '';
  return digitsOf(jid.split('@')[0].split(':')[0]);
}

// Wrappers that hold the real message one level down.
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

function unwrap(message) {
  let current = message;
  for (let depth = 0; current && depth < 5; depth++) {
    const wrapper = WRAPPERS.find((name) => current[name]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

function describeContent(content) {
  if (typeof content.conversation === 'string') {
    return { body: content.conversation, type: 'chat', hasMedia: false };
  }
  if (content.extendedTextMessage) {
    return { body: content.extendedTextMessage.text ?? '', type: 'chat', hasMedia: false };
  }
  if (content.imageMessage) {
    return { body: content.imageMessage.caption ?? '', type: 'image', hasMedia: true };
  }
  if (content.videoMessage) {
    return { body: content.videoMessage.caption ?? '', type: 'video', hasMedia: true };
  }
  if (content.audioMessage) {
    return { body: '', type: content.audioMessage.ptt ? 'ptt' : 'audio', hasMedia: true };
  }
  if (content.documentMessage) {
    return { body: content.documentMessage.caption ?? '', type: 'document', hasMedia: true };
  }
  if (content.stickerMessage) return { body: '', type: 'sticker', hasMedia: true };
  return { body: '', type: 'other', hasMedia: false };
}

const toSeconds = (value) => {
  const seconds = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(seconds) ? seconds : 0;
};

// Raw Baileys message -> bot message, or null for envelopes that carry no chat content.
export function normalizeMessage(raw) {
  if (!raw?.key || !raw.message) return null;

  const content = unwrap(raw.message);
  if (!content) return null;

  const keys = Object.keys(content).filter((name) => name !== 'messageContextInfo');
  if (keys.length > 0 && keys.every((name) => name === 'protocolMessage' || name === 'senderKeyDistributionMessage')) {
    return null;
  }
  if (keys.length === 0) return null;

  const { key } = raw;
  // Group senders may be hidden behind a LID; participantAlt holds the phone JID when known.
  const author = jidDigits(key.participantAlt) || jidDigits(key.participant);

  return {
    id: { id: key.id },
    from: key.remoteJid,
    author,
    pushName: raw.pushName || '',
    fromMe: Boolean(key.fromMe),
    ...describeContent(content),
    timestamp: toSeconds(raw.messageTimestamp),
  };
}

// Smooth pseudo waveform (0-100) so voice notes render like recorded ones; Baileys would need the
// optional audio-decode package to compute the real one.
export function fakeWaveform(rng = Math.random) {
  const wave = [];
  let level = 20 + rng() * 40;
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    level = Math.min(100, Math.max(5, level + (rng() - 0.5) * 50));
    wave.push(Math.round(level));
  }
  return Uint8Array.from(wave);
}

// Message content for an OGG/Opus buffer sent as a push-to-talk voice note.
export function voiceNoteContent(oggBuffer) {
  return {
    audio: Buffer.isBuffer(oggBuffer) ? oggBuffer : Buffer.from(oggBuffer),
    mimetype: VOICE_MIMETYPE,
    ptt: true,
    waveform: fakeWaveform(),
  };
}

// What to do when WhatsApp closes the socket. Codes are WhatsApp's stable close statuses
// (Baileys' DisconnectReason): 401 logged out, 440 replaced by another login, 515 restart
// required (expected right after scanning a QR), 403/411/500 are not recoverable by retrying.
export function classifyDisconnect(statusCode) {
  switch (statusCode) {
    case 401:
      return 'logged-out';
    case 440:
      return 'replaced';
    case 515:
      return 'restart';
    case 403:
    case 411:
    case 500:
      return 'fatal';
    default:
      return 'retry';
  }
}

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

// 1s, 2s, 4s ... capped at 30s.
export function reconnectDelayMs(attempt) {
  const step = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** step);
}

// Optional per-session proxy: "bot.proxy" for the bot, "proxy" inside a tester entry.
export function resolveSessionProxy(config, sessionId) {
  const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  if (!config || typeof config !== 'object') return null;

  const botId = config.bot?.sessionId || 'bot';
  if (sessionId === botId) return clean(config.bot?.proxy);

  const entry = (config.testers ?? []).find(
    (item) => item && typeof item === 'object' && item.id === sessionId,
  );
  return clean(entry?.proxy);
}

// Optional per-session phone number for pairing-code linking: "bot.phone" (or the top-level
// "botNumber") for the bot, "phone" inside a tester entry. Digits only; null if too short.
export function resolveSessionPhone(config, sessionId) {
  const clean = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const digits = String(value).replace(/\D/g, '');
    return digits.length >= 8 ? digits : null;
  };
  if (!config || typeof config !== 'object') return null;

  const botId = config.bot?.sessionId || 'bot';
  if (sessionId === botId) return clean(config.bot?.phone) ?? clean(config.botNumber);

  const entry = (config.testers ?? []).find(
    (item) => item && typeof item === 'object' && item.id === sessionId,
  );
  return clean(entry?.phone);
}

// Insertion-ordered map that forgets its oldest entries (bounded memory for sent messages).
export function createRecentMap(maxEntries) {
  const entries = new Map();

  return {
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    get: (key) => entries.get(key),
    delete: (key) => entries.delete(key),
    size: () => entries.size,
  };
}
