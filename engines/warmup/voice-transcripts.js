// In-process registry of what our own voice notes say, keyed by the message's inner id
// (msg.id.id, identical for sender and receivers). Lets the bot and the testers read each
// other's voice notes as text when they run in the same Node process.
const DEFAULT_MAX_ENTRIES = 500;

export function createTranscriptRegistry(maxEntries = DEFAULT_MAX_ENTRIES) {
  const entries = new Map();

  return {
    remember(innerId, text) {
      const id = String(innerId ?? '').trim();
      const clean = String(text ?? '').trim();
      if (!id || !clean) return;

      entries.delete(id);
      entries.set(id, clean);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    lookup: (innerId) => entries.get(String(innerId ?? '').trim()),
    size: () => entries.size,
  };
}

const defaultRegistry = createTranscriptRegistry();

export const rememberVoiceTranscript = (innerId, text) => defaultRegistry.remember(innerId, text);
export const lookupVoiceTranscript = (innerId) => defaultRegistry.lookup(innerId);

// The receiver's event can fire before the sender registers its transcript, so poll briefly.
// Resolves with the text, or null when nothing shows up within timeoutMs.
export async function waitForVoiceTranscript(
  innerId,
  { registry = defaultRegistry, timeoutMs = 3000, intervalMs = 150 } = {},
) {
  const end = Date.now() + timeoutMs;

  for (;;) {
    const found = registry.lookup(innerId);
    if (found) return found;

    const remaining = end - Date.now();
    if (remaining <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

export function formatVoiceLine(transcript) {
  const text = String(transcript ?? '').trim();
  return text ? `[voice note] ${text}` : '[voice note]';
}

export const isVoiceMessage = (msg) => msg?.type === 'ptt' || msg?.type === 'audio';
