// MCP tools of the Investigador de productos (pure over `ctx`, driven by investigador-mcp.js and by the tests).
//   ctx: { research (research-store), getStore (agent store: lessons, signals), dataDir, sessionId, learning, researchDir, resultFn?, now? }
// Browsing itself is NOT here: the model uses the few Claude-in-Chrome tools the guard allows (investigador-guard.js); these tools
// build the URL, remember what was measured, write the report and learn from what happened after a launch.
import fs from 'node:fs';
import path from 'node:path';

import { ctResult } from './ads-bridge.js';
import { storeCandidates } from './learning.js';
import { buildAgentLearningTools } from './learning-tools.js';
import { REUSE_DAYS } from './research-store.js';
import { SIGNAL_WEIGHTS } from './signals.js';
import { activeThresholds, DECISIONS, predictionHit, proposeThresholdUpdates, resultFromInput, mergeThresholds } from './research-thresholds.js';

export const COUNTRIES = Object.freeze(['ALL', 'CO', 'MX', 'VE', 'PE', 'AR', 'CL', 'EC', 'US', 'ES', 'BR']);
export const INVESTIGADOR_TOOL_NAMES = Object.freeze(['library_url', 'list_research', 'save_research', 'mark_launched', 'propose_threshold_update']);
const MAX_REPORT_CHARS = 6000;

/** Ad Library search URL (active ads, all media). exact = phrase between quotes; whatsapp = only ads that lead to WhatsApp. */
export function libraryUrl({ term, country = 'ALL', exact = false, whatsapp = false }) {
  const c = String(country).toUpperCase();
  if (!COUNTRIES.includes(c)) throw new Error(`country debe ser ${COUNTRIES.join(', ')}.`);
  const t = String(term ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 120) throw new Error('term debe tener entre 2 y 120 caracteres.');
  const q = `${exact ? `"${t.replace(/"/g, '')}"` : t}${whatsapp ? ' | api.whatsapp.com' : ''}`;
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${c}&media_type=all&q=${encodeURIComponent(q)}&search_type=${exact ? 'keyword_exact_phrase' : 'keyword_unordered'}`;
}

/** Reports in the folder that the database does not know (written by hand or by the skill before this app): the agent can Read them. */
export function unregisteredReports(researchDir, known) {
  try {
    const have = new Set(known.map((p) => path.resolve(p).toLowerCase()));
    return fs.readdirSync(researchDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /.md$/i.test(e.name) && !have.has(path.resolve(researchDir, e.name).toLowerCase()))
      .map((e) => ({ archivo: e.name, ruta: path.join(researchDir, e.name) }))
      .sort((a, b) => (a.archivo < b.archivo ? 1 : -1))
      .slice(0, 40);
  } catch {
    return [];
  }
}

const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}\n…(recortado)` : String(s));

/** Same logic for the MCP tool and for the app's own "mark launched" command. */
export function markLaunched(ctx, args) {
  const report = ctx.research.report(args.report_id ?? args.reportId);
  if (!report) return { error: 'No encuentro ese informe. Usa list_research para ver los ids.' };
  const thresholds = mergeThresholds(report.thresholds);
  const ctCode = args.ct_code ?? args.ctCode ?? null;
  const input = { ticket: args.ticket, costPerMessage: args.cost_per_message ?? args.costPerMessage, conversion: args.conversion, roas: args.roas };
  let source = 'usuario';
  let label = 'sin_datos';
  let result = {};
  let notice = null;
  if (ctCode) {
    const res = (ctx.resultFn ?? ctResult)(ctx.dataDir, ctCode, { since: args.launched_on ?? args.launchedOn, now: ctx.now?.() ?? Date.now() });
    if (res.available && res.label !== 'sin_datos') {
      source = 'analista';
      label = res.label;
      result = res;
    } else notice = res.available ? `${res.ct} todavía no tiene gasto suficiente para juzgar (gasto ${res.gasto}).` : res.reason;
  }
  if (label === 'sin_datos') {
    const own = resultFromInput(input, thresholds);
    label = own.label;
    result = { ...input, roas: own.roas };
    source = 'usuario';
  }
  const hit = predictionHit({ decision: report.decision, label });
  const previous = ctx.research.launch(report.id);
  const saved = ctx.research.saveLaunch({ reportId: report.id, launchedOn: args.launched_on ?? args.launchedOn, product: args.product, ctCode, source, result, label, hit, note: args.note });
  if (saved.error) return saved;
  if (hit !== null && previous?.label !== label) {
    try {
      const kind = hit ? 'lanzamiento_acertado' : 'lanzamiento_fallido';
      const store = ctx.getStore();
      store.addSignal({ sessionId: ctx.sessionId ?? null, kind, weight: SIGNAL_WEIGHTS[kind], note: `${report.topic}: ${label}` });
    } catch {
      /* the signal is a bonus */
    }
  }
  const launches = ctx.research.launches().filter((l) => l.label === 'acierto' || l.label === 'fallo');
  return {
    informe: { id: report.id, tema: report.topic, veredicto: report.verdict, decision: report.decision, conteo_principal: report.mainCount },
    real: { fuente: source, etiqueta: label, roas: result.roas ?? null, ...(source === 'analista' ? { ct: result.ct, gasto: result.gasto, ventas: result.ventas, desde: result.from } : {}) },
    acerto_la_decision: hit,
    ...(notice ? { aviso: notice } : {}),
    lanzamientos_medidos: launches.length,
    siguiente: launches.length >= 3 ? 'Ya hay 3 o más resultados medidos: llama a propose_threshold_update.' : `Faltan ${3 - launches.length} resultados medidos para proponer ajustes de umbral.`,
  };
}

export function proposeUpdates(ctx) {
  const store = ctx.getStore();
  const thresholds = activeThresholds(store.lessons('certified'));
  const launches = ctx.research.launches().map((l) => ({ id: l.reportId, verdict: l.verdict, decision: l.decision, label: l.label, mainCount: l.mainCount }));
  const { needed, candidates } = proposeThresholdUpdates(launches, thresholds);
  if (needed > 0) return { propuestas: 0, faltan_resultados: needed, nota: 'Hacen falta al menos 3 lanzamientos con resultado real (ROAS) para proponer un ajuste.' };
  const created = storeCandidates(store, candidates);
  return { propuestas: candidates.length, nuevas: created, lecciones: candidates.map((c) => c.text), nota: candidates.length ? 'Quedaron como candidatas: el usuario decide en Lecciones si se aprenden.' : 'La evidencia no es concluyente todavía (hace falta que ≥ 75 % coincida).' };
}

export function createInvestigadorTools(ctx) {
  const thresholds = () => activeThresholds(ctx.learning === false ? [] : ctx.getStore().lessons('certified'));
  return [
    {
      name: 'library_url',
      description: 'Arma la dirección exacta de la Biblioteca de anuncios de Meta (anuncios activos) para un término y un país. Úsala siempre para navegar; no escribas la URL a mano.',
      inputSchema: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Término de búsqueda (palabras sueltas, o una frase si exact es true).' },
          country: { type: 'string', enum: COUNTRIES, description: 'ALL o un país (por defecto ALL).' },
          exact: { type: 'boolean', description: 'Frase exacta: solo para rastrear a un competidor concreto.' },
          whatsapp: { type: 'boolean', description: 'Solo anuncios que llevan a WhatsApp.' },
        },
        required: ['term'],
        additionalProperties: false,
      },
      handler: (args) => ({ url: libraryUrl(args), nota: 'Ábrela con la herramienta de navegación; el conteo es el primer «~N resultados» del texto de la página.' }),
    },
    {
      name: 'list_research',
      description: `LLAMA A ESTO PRIMERO. Informes anteriores (tema, veredicto, decisión, ruta; y los archivos de la carpeta que la app no conoce, que puedes leer con Read), mediciones recientes por término y país con su edad (reutilizables si tienen ${REUSE_DAYS} días o menos: no las repitas), los umbrales vigentes y lo que pasó con los productos lanzados. Con id devuelve también el texto del informe.`,
      inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Filtra por tema o término (opcional).' }, id: { type: 'number', description: 'Id de un informe para leerlo completo (opcional).' } }, additionalProperties: false },
      handler({ topic, id } = {}) {
        const out = { umbrales_vigentes: thresholds(), dias_para_reutilizar: REUSE_DAYS };
        if (id !== undefined) {
          const r = ctx.research.report(id);
          if (!r) return { error: 'No encuentro ese informe.' };
          const inside = path.resolve(r.path).toLowerCase().startsWith(`${path.resolve(ctx.researchDir).toLowerCase()}${path.sep}`);
          out.informe = { ...r, mediciones: ctx.research.measurements(r.id), lanzamiento: ctx.research.launch(r.id), texto: inside && fs.existsSync(r.path) ? cut(fs.readFileSync(r.path, 'utf8'), MAX_REPORT_CHARS) : null };
          return out;
        }
        out.informes = ctx.research.reports({ topic, limit: 20 }).map((r) => ({ id: r.id, fecha: r.date, tema: r.topic, veredicto: r.verdict, decision: r.decision, termino_principal: r.mainTerm, conteo_principal: r.mainCount, ruta: r.path, lanzado: Boolean(ctx.research.launch(r.id)) }));
        out.mediciones_recientes = ctx.research.recentMeasurements({ term: topic }).slice(0, 60).map((m) => ({ informe: m.reportId, termino: m.term, pais: m.country, conteo: m.count, veredicto: m.verdict, fecha: m.measuredOn, edad_dias: m.ageDays, reutilizable: m.reusable }));
        out.informes_sin_registrar = unregisteredReports(ctx.researchDir, ctx.research.reports({ limit: 500 }).map((r) => r.path));
        out.lanzamientos = ctx.research.launches().map((l) => ({ informe: l.reportId, tema: l.topic, producto: l.product, veredicto_previo: l.verdict, decision: l.decision, resultado: l.label, acerto: l.hit }));
        return out;
      },
    },
    {
      name: 'save_research',
      description: 'Guarda el informe: escribe el archivo en la carpeta de investigaciones y registra términos, conteos, veredicto y umbrales para aprender después. El veredicto de cada medición lo calcula el código con los umbrales vigentes; tú aportas los números que leíste y el análisis. Llámala UNA vez al final.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Tema corto (será parte del nombre del archivo).' },
          idea: { type: 'string', description: 'La idea evaluada, una línea.' },
          summary: { type: 'string', description: 'Conclusión en una o dos frases.' },
          countries: { type: 'array', items: { type: 'string' }, description: 'Países medidos.' },
          main_term: { type: 'string', description: 'Término cuya medición decide el veredicto (por defecto el primero con país ALL).' },
          measurements: {
            type: 'array', maxItems: 60,
            items: {
              type: 'object',
              properties: {
                term: { type: 'string' }, country: { type: 'string', description: 'ALL, CO, MX...' }, count: { type: 'number', description: 'El N de «~N resultados».' },
                type: { type: 'string', enum: ['generico', 'nicho', 'formato', 'frase_exacta', 'idioma'] },
                infoproducers: { type: 'number', description: 'Cuántos infoproductores reales (no marcas) llenan ese número, si lo revisaste.' },
                note: { type: 'string' }, measured_on: { type: 'string', description: 'AAAA-MM-DD si es una medición reutilizada.' },
              },
              required: ['term', 'count'],
            },
          },
          advertisers: {
            type: 'array', maxItems: 20,
            items: { type: 'object', properties: { page: { type: 'string' }, type: { type: 'string', enum: ['marca', 'infoproductor'] }, ads: { type: 'number' }, video_ads: { type: 'number' }, days_active: { type: 'string' }, variants: { type: 'number' }, countries: { type: 'string' }, price: { type: 'string' }, channel: { type: 'string' } }, required: ['page', 'type'] },
          },
          estimate: { type: 'object', properties: { ticket: { type: 'number' }, currency: { type: 'string', description: 'Obligatorio: COP, MXN, USD...' }, cost_per_message: { type: 'number' }, conversion: { type: 'number', description: 'Entre 0 y 1, por ejemplo 0.03.' }, assumptions: { type: 'string' } }, required: ['ticket'] },
          copy_with_better_angle: { type: 'array', items: { type: 'string' }, description: 'Productos existentes que vale copiar con mejor ángulo.' },
          gaps: { type: 'array', items: { type: 'string' }, description: 'Huecos donde no hay nada (demanda por validar).' },
          risks: { type: 'array', items: { type: 'string' } },
          decision: { type: 'string', enum: DECISIONS },
          verdict: { type: 'string', enum: ['saturado', 'competitivo', 'hueco'], description: 'Tu lectura; el código guarda la suya y avisa si difieren.' },
          next_question: { type: 'string', description: 'UNA pregunta de siguiente paso.' },
        },
        required: ['topic', 'measurements', 'decision'],
      },
      handler(args) {
        const saved = ctx.research.save(args, { thresholds: thresholds() });
        if (saved.error) return saved;
        return {
          guardado: true, id: saved.id, ruta: saved.file, fecha: saved.date, veredicto_codigo: saved.verdict, termino_principal: saved.mainTerm, conteo_principal: saved.mainCount, mediciones: saved.measurements,
          ...(saved.modelVerdictDiffers ? { aviso: 'Tu veredicto difiere del que calculó el código con los umbrales; en el informe quedó el del código. Explica la diferencia al usuario.' } : {}),
          ...(saved.estimate ? { estimacion: { cpa_maximo: saved.estimate.cpaMax, veredicto: saved.estimate.verdict, ...(saved.estimate.needsCost ? { costo_por_mensaje_maximo: saved.estimate.maxCostPerMessage } : {}) } } : {}),
        };
      },
    },
    {
      name: 'mark_launched',
      description: 'Registra que un producto investigado se lanzó y compara lo previsto con lo real. Pasa ct_code si ya hay anuncios (el sistema lee el resultado real del Analista, solo lectura); si no, usa los datos que dio el usuario (roas, o ticket + cost_per_message + conversion). Nunca inventes cifras.',
      inputSchema: {
        type: 'object',
        properties: {
          report_id: { type: 'number' }, launched_on: { type: 'string', description: 'AAAA-MM-DD' }, product: { type: 'string' }, ct_code: { type: 'string', description: 'Código CT de sus anuncios, por ejemplo CT 14.' },
          ticket: { type: 'number' }, cost_per_message: { type: 'number' }, conversion: { type: 'number', description: 'Entre 0 y 1.' }, roas: { type: 'number' }, note: { type: 'string' },
        },
        required: ['report_id'],
        additionalProperties: false,
      },
      handler: (args) => markLaunched(ctx, args),
    },
    {
      name: 'propose_threshold_update',
      description: 'Con 3 o más lanzamientos medidos, propone como lecciones CANDIDATAS (el usuario las certifica) qué tan confiable fue cada veredicto y, si la evidencia separa limpio, un nuevo umbral de «competitivo». No cambia nada por sí sola.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => proposeUpdates(ctx),
    },
    ...(ctx.learning === false ? [] : buildAgentLearningTools(ctx)),
  ];
}

