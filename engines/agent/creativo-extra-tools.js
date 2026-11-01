// Free MCP tools of the Agente creativo beyond generation: the roadmap board, the list of generated files and the learning
// tools. None of them spends anything. Pure over `ctx` ({ roadmap, outputs, getStore, sessionId, learning }) so tests can drive them.
import { AGENT_LEARNING_TOOL_NAMES, buildAgentLearningTools } from './learning-tools.js';
import { STATUSES } from './creativo-roadmap.js';

export const ROADMAP_TOOL_NAMES = Object.freeze(['list_roadmap', 'mark_item', 'add_note', 'propose_next', 'list_outputs']);
const MAX_LISTED = 80;

const brief = (i) => ({
  item_id: i.id, producto: i.productId, pais: i.country, plantilla: i.templateId, titulo: i.title, estado: i.status, marcado_por: i.markedBy, detalle: i.detail,
  evidencia: i.evidencePath, evidencia_rota: i.evidenceBroken || undefined, notas: i.notes ? i.notes.split('\n').slice(-2).join(' | ') : undefined,
});

export function createRoadmapTools(ctx) {
  return [
    {
      name: 'list_roadmap',
      description: 'Hoja de ruta de los productos: qué ítems de la lista estándar (investigación, PDF, guiones, audios, videos, flujo, anuncios) están hechos, en progreso o pendientes por producto y país, con el avance en %. Se comprueba contra los archivos reales. Úsala antes de decir qué le falta a un producto.',
      inputSchema: {
        type: 'object',
        properties: {
          product: { type: 'string', description: 'Producto, por ejemplo "Bebidas" (opcional).' },
          country: { type: 'string', description: 'País: colombia, mexico, venezuela... (opcional).' },
          status: { type: 'string', enum: STATUSES, description: 'Solo ítems con este estado (opcional).' },
        },
        additionalProperties: false,
      },
      handler({ product, country, status } = {}) {
        ctx.roadmap.seed();
        const board = ctx.roadmap.board({ product });
        const items = ctx.roadmap.items({ product, country, status });
        const shown = [...items].sort((a, b) => (a.status === 'hecho') - (b.status === 'hecho')).slice(0, MAX_LISTED);
        return {
          productos: board.map((b) => ({ producto: b.name, avance_por_pais: b.progress })),
          items: shown.map(brief),
          ...(items.length > shown.length ? { nota: `Se muestran ${shown.length} de ${items.length}; filtra por producto, país o estado.` } : {}),
        };
      },
    },
    {
      name: 'mark_item',
      description: 'Cambia el estado de un ítem de la hoja de ruta. Para «hecho» DEBES pasar evidence_path (ruta relativa a la carpeta de trabajo de un archivo o carpeta que exista); sin evidencia en disco se rechaza. No puedes cambiar lo que marcó el usuario. «no_aplica» exige note con el motivo.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'number' },
          status: { type: 'string', enum: STATUSES },
          evidence_path: { type: 'string', description: 'Archivo o carpeta que prueba el avance, por ejemplo "Producto Bebidas/audios/venezuela/contenido".' },
          note: { type: 'string' },
        },
        required: ['item_id', 'status'],
        additionalProperties: false,
      },
      handler: ({ item_id: id, status, evidence_path: evidencePath, note }) => {
        const res = ctx.roadmap.mark({ id, status, evidencePath, note, by: 'agente' });
        return res.error ? res : { item: brief(res.item) };
      },
    },
    {
      name: 'add_note',
      description: 'Agrega una nota corta a un ítem de la hoja de ruta (decisiones, bloqueos, qué falta).',
      inputSchema: { type: 'object', properties: { item_id: { type: 'number' }, text: { type: 'string' } }, required: ['item_id', 'text'], additionalProperties: false },
      handler: ({ item_id: id, text }) => {
        const res = ctx.roadmap.addNote(id, text, 'agente');
        return res.error ? res : { item: brief(res.item) };
      },
    },
    {
      name: 'propose_next',
      description: 'Los siguientes ítems por hacer de un producto o país: pendientes o en progreso cuyas dependencias ya están hechas, en el orden de la lista. Calculado por código. Úsalo para responder «¿qué sigue?».',
      inputSchema: { type: 'object', properties: { product: { type: 'string' }, country: { type: 'string' } }, additionalProperties: false },
      handler: ({ product, country } = {}) => {
        ctx.roadmap.seed();
        return { siguientes: ctx.roadmap.proposeNext({ product, country, limit: 5 }).map((i) => ({ ...brief(i), skill: i.skill, manual: i.manual || undefined })) };
      },
    },
    {
      name: 'list_outputs',
      description: 'Archivos que generaste (imágenes, arte de PDF, audios) y qué hizo el usuario con ellos: generated, used o discarded, y el CT al que los ligó. Úsalo para saber qué le sirvió.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['generated', 'used', 'discarded'] } }, additionalProperties: false },
      handler: ({ status } = {}) => ({ archivos: ctx.outputs.list({ status, limit: 60 }).map((o) => ({ id: o.id, tipo: o.kind, producto: o.product, pais: o.country, ruta: o.path, estado: o.status, ct: o.ctCode })) }),
    },
  ];
}

/** Everything the creativo offers besides the generation tools; learning tools only when the learning switch is on. */
export function createCreativoExtraTools(ctx) {
  return [...createRoadmapTools(ctx), ...(ctx.learning === false ? [] : buildAgentLearningTools(ctx))];
}

export { AGENT_LEARNING_TOOL_NAMES };
