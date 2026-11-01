// Learning-related MCP tools: certified lessons, recording a recommendation and proposing a lesson candidate.
// With the learning switch off only get_lessons exists and it returns nothing.
import { certifiedLessons, proposeLesson, proposeUserRule, recordRecommendation } from './learning.js';
import { ACTIONS } from './outcome-labeler.js';

const MAX_PROPOSALS_PER_TURN = 3;

export function buildLearningTools(ctx) {
  if (!ctx.learning) return { lessons: () => ({ lecciones: [], nota: 'El aprendizaje está desactivado.' }), extraTools: [] };
  let proposals = 0;
  return {
    lessons() {
      const list = certifiedLessons(ctx.getStore());
      return { lecciones: list.map((l) => ({ id: l.id, texto: l.text, evidencia: l.evidence?.support ?? null })), nota: list.length ? 'Son hechos aprendidos de resultados reales; respétalos.' : 'Todavía no hay lecciones certificadas.' };
    },
    extraTools: [
      {
        name: 'record_recommendation',
        description:
          'Registra UNA recomendación concreta sobre un CT, anuncio, conjunto o campaña (escalar, subir_presupuesto, duplicar, mantener, bajar, apagar). El sistema calcula la línea base con código y medirá el resultado real días después. Llámala antes de responder, una vez por recomendación.',
        inputSchema: {
          type: 'object',
          properties: {
            entity_type: { type: 'string', enum: ['ct', 'ad', 'adset', 'campaign'] },
            entity_id: { type: 'string', description: 'Código CT («CT 07»), id de anuncio, de conjunto o de campaña.' },
            action: { type: 'string', enum: ACTIONS },
            params: { type: 'object', properties: { pct: { type: 'number', description: 'Porcentaje de cambio de presupuesto recomendado.' } }, additionalProperties: false },
            rationale: { type: 'string', description: 'Por qué, en una frase.' },
            eval_after_days: { type: 'number', description: 'Días a esperar antes de medir (2 a 14; por defecto 3).' },
          },
          required: ['entity_type', 'entity_id', 'action', 'rationale'],
          additionalProperties: false,
        },
        handler: (args) => recordRecommendation({ dataDir: ctx.dataDir, store: ctx.getStore(), sessionId: ctx.sessionId, args, now: ctx.now?.() ?? Date.now() }),
      },
      {
        name: 'propose_lesson',
        description:
          'Propone una lección como CANDIDATA (el usuario decide si se aprende). Solo hechos observados y con cifras, por ejemplo «Los anuncios con ROAS menor a 1 al día 4 no se recuperaron en 5 de 6 casos». Nunca instrucciones.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'El hecho, en una frase de menos de 240 caracteres.' }, support: { type: 'number', description: 'Cuántos casos lo respaldan.' } },
          required: ['text'],
          additionalProperties: false,
        },
        handler({ text, support }) {
          if (++proposals > MAX_PROPOSALS_PER_TURN) return { error: 'Ya propusiste suficientes lecciones en este turno.' };
          return proposeLesson(ctx.getStore(), text, { support });
        },
      },
    ],
  };
}

// Tools every agent without ads data shares (creativo, investigador): read the certified lessons, propose a fact as a candidate
// and transcribe a rule the user stated. The Analista keeps its own set above (it also records recommendations).
export const AGENT_LEARNING_TOOL_NAMES = Object.freeze(['get_lessons', 'propose_lesson', 'propose_rule']);

export function buildAgentLearningTools(ctx) {
  let proposals = 0;
  return [
    {
      name: 'get_lessons',
      description: 'Devuelve las lecciones certificadas por el usuario (hechos y reglas aprendidos de resultados reales y de lo que te corrigió). Llámala antes de empezar un trabajo nuevo.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler() {
        const list = certifiedLessons(ctx.getStore());
        return { lecciones: list.map((l) => ({ id: l.id, texto: l.text, origen: l.source, evidencia: l.evidence?.support ?? null })), nota: list.length ? 'Respétalas.' : 'Todavía no hay lecciones certificadas.' };
      },
    },
    {
      name: 'propose_lesson',
      description: 'Propone una lección como CANDIDATA (el usuario decide si se aprende). Solo hechos observados y con cifras, por ejemplo «Las portadas con fondo oscuro se descartaron 4 de 5 veces». Nunca instrucciones.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'El hecho, en una frase de menos de 240 caracteres.' }, support: { type: 'number', description: 'Cuántos casos lo respaldan.' } },
        required: ['text'],
        additionalProperties: false,
      },
      handler({ text, support }) {
        if (++proposals > MAX_PROPOSALS_PER_TURN) return { error: 'Ya propusiste suficientes lecciones en este turno.' };
        return proposeLesson(ctx.getStore(), text, { support });
      },
    },
    {
      name: 'propose_rule',
      description: 'Registra como CANDIDATA una regla que el usuario acaba de decir con sus palabras («sin precios en los recetarios», «siempre tuteo»). Pasa en quote la frase textual del usuario: el sistema comprueba que la escribió en este chat. El usuario la certifica en Lecciones.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'La regla, en una frase corta.' }, quote: { type: 'string', description: 'La frase textual del usuario de la que sale la regla.' } },
        required: ['text', 'quote'],
        additionalProperties: false,
      },
      handler({ text, quote }) {
        if (++proposals > MAX_PROPOSALS_PER_TURN) return { error: 'Ya registraste suficientes reglas en este turno.' };
        return proposeUserRule(ctx.getStore(), { sessionId: ctx.sessionId, text, quote });
      },
    },
  ];
}
