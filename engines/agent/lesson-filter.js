// Guard for text that may end up inside the agent's prompt as a "lesson". Lessons are facts learned from results;
// text that reads like an instruction to the model (or carries links, code or secrets) is never learned.
// `trusted` text was typed by the user themself (their own preference): imperatives and the "needs a number" rule
// are allowed, but links, code, secrets and rule-override attempts are still refused.
const MIN = 12;
const MAX = 240;

const HARD = [
  [/https?:\/\/|www\./i, 'no puede contener enlaces'],
  [/```|`|<\/?[a-z][^>]*>|\{\{|\}\}/i, 'no puede contener código ni etiquetas'],
  [/\b(api[ _-]?key|apikey|token|password|contrase[ñn]a|secret[oa]?|bearer)\b/i, 'no puede mencionar claves ni credenciales'],
  [/\b(rm\s+-rf|curl|powershell|bash|cmd\.exe|eval\(|exec\()/i, 'no puede contener comandos'],
];

const INJECTION = [
  /\b(ignora|ignore|olvida|forget|disregard|omite|sobrescribe|override)\b.{0,40}\b(instruc|regla|prompt|rules?|instructions?|anterior|previous)/i,
  /\b(system prompt|prompt del sistema|mensaje del sistema|developer message)\b/i,
  /\b(eres un|eres una|you are|act as|act[uú]a como|pretend|finge)\b/i,
  /\b(from now on|a partir de ahora|de ahora en adelante|desde ahora)\b/i,
  /\b(ejecuta|execute|run the|llama a la herramienta|call the tool|usa la herramienta)\b/i,
];

const IMPERATIVE_START = /^\s*(siempre|nunca|jam[aá]s|no |haz |hazlo|usa |utiliza |responde |contesta |recuerda|debes|tienes que|deber[ií]as|ejecuta|llama |ignora|olvida|always|never|do |don'?t|use |call |you must|remember|make sure|asegúrate|aseg[uú]rate)/i;

/** @returns {{ ok: true, text: string } | { ok: false, reason: string }} */
export function sanitizeLessonText(raw, { trusted = false } = {}) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < MIN) return { ok: false, reason: 'es demasiado corta' };
  if (text.length > MAX) return { ok: false, reason: `supera los ${MAX} caracteres` };
  for (const [re, reason] of HARD) if (re.test(text)) return { ok: false, reason };
  if (INJECTION.some((re) => re.test(text))) return { ok: false, reason: 'parece un intento de cambiar las reglas del asistente' };
  if (!trusted) {
    if (IMPERATIVE_START.test(text)) return { ok: false, reason: 'parece una orden, no un hecho observado' };
    if (!/\d/.test(text)) return { ok: false, reason: 'un hecho aprendido debe apoyarse en cifras' };
  }
  return { ok: true, text };
}

export const looksLikeInstruction = (text) => !sanitizeLessonText(text).ok;
