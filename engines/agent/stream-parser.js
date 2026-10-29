// Parses `claude -p --output-format stream-json --verbose --include-partial-messages` into the small event set the UI
// understands. Pure: feed it one line at a time. Unknown line types are ignored on purpose (the CLI adds new ones).
//
// Output events:
//   { type: 'init', claudeSessionId, mcp: [{ name, status }], tools: string[] }
//   { type: 'message_start' }                       a new assistant message begins (UI resets its streaming buffer)
//   { type: 'text', delta }                         streamed assistant text
//   { type: 'step', id, tool, label }               a tool call started (friendly progress text)
//   { type: 'step_done', id, tool, ok, summary }    its result arrived
//   { type: 'plan', status, fiveHour, resetsAt }      plan usage window reported by the CLI (subscription limits)
//   { type: 'result', ok, text, claudeSessionId, durationMs, turns, usage, subtype, error? }

export const SERVER_NAME = 'analista';

const short = (name) => {
  const n = String(name ?? '');
  return n.startsWith('mcp__') ? n.split('__').slice(2).join('__') : n;
};
const cut = (s, n = 70) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

// Friendly Spanish progress text for a tool call.
export function stepLabel(name, input = {}) {
  const tool = short(name);
  switch (tool) {
    case 'list_views':
      return 'Revisando qué datos tengo disponibles…';
    case 'query_sql':
      return input.purpose ? `Consultando ${cut(String(input.purpose).replace(/^consultando\s+/i, ''))}…` : 'Consultando los datos…';
    case 'metrics': {
      const scope = input.ct ? ` de ${input.ct}` : '';
      const what = { kpis: 'Calculando totales', table: 'Armando la tabla', daily: 'Calculando la serie diaria', countries: 'Comparando países', lifecycle: 'Revisando los días de cada anuncio', budget_compare: 'Comparando antes y después de la subida de presupuesto' }[input.kind] ?? 'Calculando métricas';
      return `${what}${scope}…`;
    }
    case 'get_lessons':
      return 'Revisando las lecciones aprendidas…';
    case 'record_recommendation':
      return 'Guardando la recomendación para medir su resultado…';
    case 'propose_lesson':
      return 'Proponiendo una lección para que la revises…';
    case 'WebSearch':
      return input.query ? `Buscando en la web: ${cut(input.query)}…` : 'Buscando en la web…';
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(input.url).host;
      } catch {
        /* keep empty */
      }
      return host ? `Leyendo ${host}…` : 'Leyendo una página web…';
    }
    default:
      return `Usando ${tool}…`;
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n');
  return '';
}

// One-line summary of a tool result ("12 filas", error text...).
export function summarizeResult(tool, text, isError) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text result (web tools) */
  }
  if (isError || (data && typeof data.error === 'string')) return cut(data?.error ?? text, 110) || 'Falló';
  if (data && typeof data.filas_devueltas === 'number') return `${data.filas_devueltas} ${data.filas_devueltas === 1 ? 'fila' : 'filas'}${data.truncado ? ' (recortado)' : ''}`;
  if (data && Array.isArray(data.filas)) return `${data.filas.length} filas`;
  if (data && Array.isArray(data.dias)) return `${data.dias.length} días`;
  if (data && Array.isArray(data.cambios)) return `${data.cambios.length} cambios de presupuesto`;
  if (data && Array.isArray(data.anuncios)) return `${data.anuncios.length} anuncios`;
  if (data && Array.isArray(data.paises)) return `${data.paises.length} países`;
  if (data && Array.isArray(data.lecciones)) return `${data.lecciones.length} lecciones`;
  if (data && data.totales) return 'listo';
  return 'listo';
}

export function usageOf(u = {}) {
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  const cacheRead = Number(u.cache_read_input_tokens ?? 0);
  const cacheCreate = Number(u.cache_creation_input_tokens ?? 0);
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
}

const LOGIN_HINT = /not logged in|please run \/login|invalid api key|authentication|oauth token has expired|401/i;
const LIMIT_HINT = /usage limit|rate limit|limit reached|too many requests|429|overloaded/i;

export function friendlyError(message) {
  const text = String(message ?? '');
  if (LOGIN_HINT.test(text)) return 'Claude Code no tiene la sesión iniciada. Abre una terminal, escribe `claude` y entra con tu cuenta; luego vuelve a intentar.';
  if (LIMIT_HINT.test(text)) return 'Se alcanzó el límite de uso de tu plan de Claude por ahora. Espera a que se renueve e inténtalo de nuevo.';
  return cut(text, 300) || 'Claude Code terminó con un error.';
}

export function createStreamParser() {
  const pendingTools = new Map(); // tool_use id -> tool name
  const toolResults = []; // { id, tool, text, isError }
  let claudeSessionId = null;
  let lastAssistantText = '';

  return {
    toolResults,
    get claudeSessionId() {
      return claudeSessionId;
    },
    get lastAssistantText() {
      return lastAssistantText;
    },
    /** @returns {object[]} zero or more normalized events */
    feed(line) {
      const trimmed = String(line ?? '').trim();
      if (!trimmed.startsWith('{')) return [];
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (msg.session_id) claudeSessionId = msg.session_id;
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            return [{ type: 'init', claudeSessionId: msg.session_id ?? null, mcp: (msg.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status })), tools: msg.tools ?? [] }];
          }
          return [];
        case 'stream_event': {
          const ev = msg.event ?? {};
          if (ev.type === 'message_start') return [{ type: 'message_start' }];
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) return [{ type: 'text', delta: ev.delta.text }];
          return [];
        }
        case 'assistant': {
          const events = [];
          const blocks = msg.message?.content ?? [];
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (text) lastAssistantText = text;
          for (const b of blocks) {
            if (b.type !== 'tool_use') continue;
            pendingTools.set(b.id, b.name);
            events.push({ type: 'step', id: b.id, tool: short(b.name), label: stepLabel(b.name, b.input) });
          }
          return events;
        }
        case 'user': {
          const events = [];
          const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of blocks) {
            if (b.type !== 'tool_result') continue;
            const tool = short(pendingTools.get(b.tool_use_id) ?? '');
            const text = resultText(b.content);
            const isError = b.is_error === true;
            toolResults.push({ id: b.tool_use_id, tool, text, isError });
            events.push({ type: 'step_done', id: b.tool_use_id, tool, ok: !isError && !/^\{"error"/.test(text.trim()), summary: summarizeResult(tool, text, isError) });
          }
          return events;
        }
        case 'result': {
          const ok = msg.is_error !== true && msg.subtype === 'success';
          return [{
            type: 'result', ok, subtype: msg.subtype ?? null, text: typeof msg.result === 'string' ? msg.result : lastAssistantText, claudeSessionId: msg.session_id ?? claudeSessionId,
            durationMs: Number(msg.duration_ms ?? 0), turns: Number(msg.num_turns ?? 0), usage: usageOf(msg.usage), ...(ok ? {} : { error: friendlyError(msg.result ?? msg.subtype) }),
          }];
        }
        case 'rate_limit_event': {
          const info = msg.rate_limit_info ?? {};
          const five = info.unifiedWindows?.five_hour;
          return [{ type: 'plan', status: info.status ?? null, fiveHour: typeof five?.utilization === 'number' ? five.utilization : null, resetsAt: five?.resetsAt ?? info.resetsAt ?? null }];
        }
        default:
          return [];
      }
    },
  };
}
