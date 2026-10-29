// Command parser for incoming WhatsApp messages. No LLM: a handful of exact patterns.

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// "3000", "2,5", "2.5" and "2.500" (Colombian thousands) -> number; anything else -> null.
export function parseNumber(text) {
  const raw = String(text ?? '').trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(raw)) return Number(raw.replace(/\./g, ''));
  if (/^\d+([.,]\d+)?$/.test(raw)) return Number(raw.replace(',', '.'));
  return null;
}

export function parseCommand(input) {
  if (typeof input !== 'string') return { type: 'unknown' };
  const text = strip(input).trim().toLowerCase().replace(/[.!?\s]+$/, '');
  if (!text) return { type: 'unknown' };

  const simple = { estado: 'status', ayuda: 'help', detener: 'stop', reanudar: 'resume' };
  if (simple[text]) return { type: simple[text] };

  const withId = /^(si|no|aceptar)(?:\s+(\d+))?$/.exec(text);
  if (withId) {
    const type = { si: 'approve', no: 'reject', aceptar: 'accept' }[withId[1]];
    return { type, id: withId[2] ? Number(withId[2]) : null };
  }

  const pause = /^pausa alertas(?:\s+(\S+))?$/.exec(text);
  if (pause) {
    const minutes = pause[1] === undefined ? null : parseNumber(pause[1]);
    return minutes === null ? { type: 'invalid', command: 'pausa alertas' } : { type: 'pause_alerts', minutes };
  }

  const set = /^valor(?:\s+(\S+))?(?:\s+(\S+))?$/.exec(text);
  if (set) {
    const value = set[2] === undefined ? null : parseNumber(set[2]);
    if (!set[1] || value === null) return { type: 'invalid', command: 'valor' };
    return { type: 'set', name: set[1], value };
  }

  return { type: 'unknown' };
}
