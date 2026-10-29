// The MCP tools of the Analista. Everything here is read-only over ads.db; the only writes go to agent.db
// (query log, and in the learning phase recommendations / candidate lessons).
import { describeViews, glossaryText, SQL_RULES, GLOSSARY } from './knowledge.js';
import { loadDataset, METRIC_KINDS, MetricsError, runMetric } from './metrics.js';
import { adsDbPath } from './paths.js';
import { runQuery } from './query-runner.js';

export const BASE_TOOL_NAMES = Object.freeze(['list_views', 'query_sql', 'metrics', 'get_lessons']);
export const LEARNING_TOOL_NAMES = Object.freeze(['record_recommendation', 'propose_lesson']);

const ISO = { type: 'string', description: 'Fecha AAAA-MM-DD.' };

export function createTools(ctx) {
  const { dataDir, sessionId = null, question = null, getStore, now = Date.now } = ctx;
  const store = () => getStore();

  return [
    {
      name: 'list_views',
      description:
        'Lista las vistas SQL permitidas (con sus columnas y significado), el glosario del negocio y las reglas de SQL. Llámala al empezar una conversación nueva y cuando dudes del nombre de una columna.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler() {
        return {
          vistas: describeViews(),
          glosario: Object.fromEntries(GLOSSARY),
          reglas_sql: SQL_RULES,
          resumen_glosario: glossaryText(),
          ejemplo: "SELECT ct, SUM(spend) AS gasto, SUM(sales) AS ventas, ROUND(SUM(revenue_cop) / NULLIF(SUM(spend), 0), 2) AS roas FROM v_ct_daily WHERE date BETWEEN '2026-10-01' AND '2026-10-07' GROUP BY ct ORDER BY gasto DESC",
        };
      },
    },
    {
      name: 'query_sql',
      description:
        'Ejecuta UNA consulta SELECT de solo lectura sobre las vistas v_* (máx. 200 filas, 5 s). Úsala para preguntas que metrics no cubre. Siempre indica `purpose`, una frase corta que se le muestra al usuario («ventas de CT 07 por día»).',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Sentencia SELECT o WITH...SELECT sobre las vistas permitidas.' },
          purpose: { type: 'string', description: 'Qué estás consultando, en pocas palabras y en español.' },
        },
        required: ['sql', 'purpose'],
        additionalProperties: false,
      },
      async handler({ sql, purpose }) {
        const res = await runQuery(adsDbPath(dataDir), sql);
        try {
          store().logQuery({
            sessionId, question, purpose, sql: typeof sql === 'string' ? sql : String(sql),
            status: res.ok ? 'ok' : res.rejected ? 'rejected' : 'error', layer: res.layer ?? null, reason: res.ok ? null : res.error, rows: res.ok ? res.rowCount : null, ms: res.ms,
          });
        } catch {
          /* the log must never break an answer */
        }
        if (!res.ok) {
          return { error: res.error, capa: res.layer ?? 'ejecucion', consejo: 'Corrige la consulta usando solo las vistas v_* y las funciones permitidas (ver list_views).' };
        }
        return { columnas: res.columns, filas: res.rows, filas_devueltas: res.rowCount, truncado: res.truncated, ms: res.ms };
      },
    },
    {
      name: 'metrics',
      description:
        'Cálculos deterministas del negocio (usan el mismo código que la pantalla Anuncios). kind: kpis (totales de un periodo), table (una fila por CT/campaña/anuncio con acción sugerida), daily (serie diaria), countries (comparar países), lifecycle (día N de cada anuncio y acumulado), budget_compare (antes vs después de cada subida de presupuesto, con el veredicto de la app). Prefiérela a calcular a mano.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: METRIC_KINDS },
          from: { ...ISO, description: 'Inicio del periodo (por defecto, hace 6 días).' },
          to: { ...ISO, description: 'Fin del periodo (por defecto, hoy).' },
          ct: { type: 'string', description: 'Código CT, por ejemplo «CT 07».' },
          ad_id: { type: 'string', description: 'ID de un anuncio.' },
          country: { type: 'string', description: 'CO, MX, VE o «all».' },
          group: { type: 'string', enum: ['ct', 'campaign', 'ad'], description: 'Solo para table.' },
          split: { type: 'boolean', description: 'Solo para table: separar cada fila por país.' },
          since: { ...ISO, description: 'Solo para budget_compare: desde cuándo mirar las subidas (por defecto, 60 días).' },
          after_days: { type: 'number', description: 'Solo para budget_compare: días posteriores al cambio a evaluar.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      handler(args) {
        try {
          return runMetric(loadDataset(dataDir, now()), args);
        } catch (error) {
          if (error instanceof MetricsError) return { error: error.message };
          throw error;
        }
      },
    },
    {
      name: 'get_lessons',
      description: 'Devuelve las lecciones certificadas por el usuario (hechos aprendidos de resultados reales de recomendaciones anteriores). Llámala antes de recomendar una acción.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler() {
        return ctx.lessons ? ctx.lessons() : { lecciones: [], nota: 'Todavía no hay lecciones certificadas.' };
      },
    },
    ...(ctx.extraTools ?? []),
  ];
}
