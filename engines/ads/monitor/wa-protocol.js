// Pure helpers for the Baileys layer (adapted from ../whatsapp-bot-tester/wa-messages.js).
const USER_SERVER = '@s.whatsapp.net';

export const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

export function toJid(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.includes('@')) return text;
  const digits = digitsOf(text);
  return digits ? `${digits}${USER_SERVER}` : '';
}

// "57300...:12@s.whatsapp.net" -> "57300...". LIDs and groups carry no phone number: ''.
export function jidDigits(jid) {
  if (typeof jid !== 'string' || !jid.endsWith(USER_SERVER)) return '';
  return digitsOf(jid.split('@')[0].split(':')[0]);
}

// What to do when WhatsApp closes the socket (stable close status codes).
export function classifyDisconnect(statusCode) {
  switch (statusCode) {
    case 401: return 'logged-out';
    case 440: return 'replaced';
    case 515: return 'restart';
    case 403:
    case 411:
    case 500: return 'fatal';
    default: return 'retry';
  }
}

export function reconnectDelayMs(attempt) {
  const step = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(30_000, 1000 * 2 ** step);
}

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'editedMessage'];

function unwrap(message) {
  let current = message;
  for (let depth = 0; current && depth < 5; depth++) {
    const wrapper = WRAPPERS.find((name) => current[name]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

// Raw Baileys message -> { id, senderDigits, text, fromMe, isGroup }, or null when it is not text.
export function normalizeIncoming(raw) {
  if (!raw?.key || !raw.message) return null;
  const content = unwrap(raw.message);
  const text = content?.conversation ?? content?.extendedTextMessage?.text;
  if (typeof text !== 'string') return null;

  const { key } = raw;
  const isGroup = typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@g.us');
  // Chats may be addressed by LID; remoteJidAlt carries the phone JID when WhatsApp knows it.
  const senderDigits = isGroup
    ? jidDigits(key.participantAlt) || jidDigits(key.participant)
    : jidDigits(key.remoteJidAlt) || jidDigits(key.remoteJid);

  return { id: key.id, senderDigits, text, fromMe: Boolean(key.fromMe), isGroup };
}

// Only 1:1 messages from the configured number are accepted. The placeholder never matches.
export function isFromAllowed(message, allowedNumber) {
  const allowed = digitsOf(allowedNumber);
  if (!allowed || message.fromMe || message.isGroup || !message.senderDigits) return false;
  return message.senderDigits === allowed;
}
