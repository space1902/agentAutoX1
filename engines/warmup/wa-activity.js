// Per-session activity log used by the health report. WhatsApp Web exposed each account's chat
// history; Baileys keeps none, so every message a session sends or receives is appended here as
// metadata only (time, chat, direction, type, text length) and never as text.
import fs from 'node:fs';
import path from 'node:path';

const STATUS_CHAT = 'status@broadcast';

const activityFile = (dir, session) => path.join(dir, `activity-${session}.jsonl`);

// Normalized message -> compact log record, or null when it should not be logged.
export function activityRecord(msg) {
  if (!msg || !msg.from || msg.from === STATUS_CHAT) return null;
  if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) return null;

  return {
    t: msg.timestamp,
    me: msg.fromMe ? 1 : 0,
    chat: msg.from,
    type: msg.type ?? 'other',
    len: String(msg.body ?? '').length,
  };
}

// Logging must never break a run, so every failure is swallowed.
export function appendActivity(dir, session, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(activityFile(dir, session), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Ignore: the activity log is best effort.
  }
}

// Messages inside the window plus the earliest sent one ever logged, in the shape
// health-analysis expects from a client.
export function parseActivity(text, sinceSeconds) {
  const messages = [];
  const chats = new Set();
  let earliestSent = null;

  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || !Number.isFinite(record.t)) continue;

    if (record.me && (earliestSent === null || record.t < earliestSent)) earliestSent = record.t;
    if (record.t < sinceSeconds) continue;

    chats.add(record.chat);
    messages.push({
      fromMe: Boolean(record.me),
      timestamp: record.t,
      chatId: record.chat,
      bodyLength: record.len ?? 0,
      type: record.type,
    });
  }

  return { messages, earliestSent, chatsSeen: chats.size, chatsSkipped: 0 };
}

export function readActivity(dir, session, sinceSeconds) {
  let text = '';
  try {
    text = fs.readFileSync(activityFile(dir, session), 'utf8');
  } catch {
    // No activity recorded yet.
  }
  return parseActivity(text, sinceSeconds);
}
