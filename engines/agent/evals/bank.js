// Question bank. Each question knows how to compute the TRUTH from the live dataset when the run starts: nothing about
// the expected answers is stored, so the bank never goes stale. Categories:
//   numeric   -> compared by code (compare.js)
//   judged    -> a cheap model with a strict rubric (judge.js); undecidable ones leave the denominator
//   scope / refuse -> out of scope, nonexistent data, predictions, private data: must NOT invent
import { addDays } from '../../ads/time.js';
import { runMetric } from '../metrics.js';

const money = (label, value) => ({ label, value, kind: 'money' });
const count = (label, value) => ({ label, value, kind: 'count' });
const ratio = (label, value) => ({ label, value, kind: 'ratio' });

const periods = (ds) => ({
  week: { from: addDays(ds.today, -6), to: ds.today },
  yesterday: { from: addDays(ds.today, -1), to: addDays(ds.today, -1) },
  month: { from: addDays(ds.today, -29), to: ds.today },
});
const between = (r) => `entre el ${r.from} y el ${r.to}`;
const skip = (reason) => ({ skip: reason });

export const BANK = [
  {
    id: 'q01-gasto-semana', category: 'numeric',
    build(ds) {
      const p = periods(ds).week;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      return { question: `¿Cuánto gasté en total ${between(p)}?`, numbers: [money('gasto total', t.gasto)] };
    },
  },
  {
    id: 'q02-ventas-semana', category: 'numeric',
    build(ds) {
      const p = periods(ds).week;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      return { question: `¿Cuántas ventas válidas tuve ${between(p)}?`, numbers: [count('ventas', t.ventas)] };
    },
  },
  {
    id: 'q03-roas-semana', category: 'numeric',
    build(ds) {
      const p = periods(ds).week;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      if (!t.gasto) return skip('Sin gasto en el periodo.');
      return { question: `¿Cuál fue mi ROAS total ${between(p)}?`, numbers: [ratio('ROAS', t.roas)] };
    },
  },
  {
    id: 'q04-costo-venta-semana', category: 'numeric',
    build(ds) {
      const p = periods(ds).week;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      if (t.costo_por_venta === null) return skip('Sin ventas en el periodo.');
      return { question: `¿Cuál fue mi costo por venta ${between(p)}?`, numbers: [money('costo por venta', t.costo_por_venta)] };
    },
  },
  {
    id: 'q05-ct-mas-gasto', category: 'numeric',
    build(ds) {
      const p = periods(ds).month;
      const top = runMetric(ds, { kind: 'table', group: 'campaign', ...p }).filas.filter((r) => r.campaign_id)[0];
      if (!top) return skip('Ninguna campaña con gasto.');
      return { question: `¿Qué campaña gastó más ${between(p)} y cuánto gastó?`, numbers: [money('gasto de la campaña', top.gasto)], mention: [top.etiqueta] };
    },
  },
  {
    id: 'q06-mejor-roas', category: 'numeric',
    build(ds) {
      const p = periods(ds).month;
      const min = ds.config.thresholds.minSpend;
      const rows = runMetric(ds, { kind: 'table', group: 'campaign', ...p }).filas.filter((r) => r.campaign_id && r.gasto >= min).sort((a, b) => b.roas - a.roas);
      if (!rows.length) return skip('Ninguna campaña supera el gasto mínimo.');
      return { question: `Entre las campañas con al menos $${min.toLocaleString('es-CO')} de gasto ${between(p)}, ¿cuál tiene el mejor ROAS y de cuánto es?`, numbers: [ratio('ROAS', rows[0].roas)], mention: [rows[0].etiqueta] };
    },
  },
  {
    id: 'q07-gasto-ayer', category: 'numeric',
    build(ds) {
      const p = periods(ds).yesterday;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      return { question: `¿Cuánto gasté ayer (${p.from})?`, numbers: [money('gasto de ayer', t.gasto)] };
    },
  },
  {
    id: 'q08-ingresos-mes', category: 'numeric',
    build(ds) {
      const p = periods(ds).month;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      return { question: `¿Cuántos ingresos en COP tuve ${between(p)}?`, numbers: [money('ingresos', t.ingresos)] };
    },
  },
  {
    id: 'q09-margen-mes', category: 'numeric',
    build(ds) {
      const p = periods(ds).month;
      const t = runMetric(ds, { kind: 'kpis', ...p }).totales;
      return { question: `¿Cuál fue mi margen total en pesos ${between(p)}?`, numbers: [money('margen', t.margen)] };
    },
  },
  {
    id: 'q10-pais-principal', category: 'numeric',
    build(ds) {
      const p = periods(ds).month;
      const top = runMetric(ds, { kind: 'countries', ...p }).paises.sort((a, b) => b.gasto - a.gasto)[0];
      if (!top || !top.gasto) return skip('Sin gasto por país.');
      return { question: `¿Qué país concentró más gasto ${between(p)} y cuántas ventas tuvo?`, numbers: [count('ventas del país', top.ventas)], mention: [top.nombre] };
    },
  },
  {
    id: 'q11-subidas-presupuesto', category: 'numeric',
    build(ds) {
      const res = runMetric(ds, { kind: 'budget_compare' });
      return { question: 'En los últimos 60 días, ¿cuántas subidas de presupuesto detectó la app?', numbers: [count('subidas', res.total_cambios)] };
    },
  },
  {
    id: 'q12-anuncios-activos', category: 'numeric',
    build(ds) {
      const active = Object.values(ds.ads).filter((a) => a.effectiveStatus === 'ACTIVE').length;
      return { question: '¿Cuántos anuncios están activos ahora mismo según los datos sincronizados?', numbers: [count('anuncios activos', active)] };
    },
  },
  {
    id: 'q13-anuncio-mas-reciente', category: 'numeric',
    build(ds) {
      const list = runMetric(ds, { kind: 'lifecycle' }).anuncios;
      if (!list.length) return skip('Sin anuncios con gasto.');
      const newest = list[0];
      return { question: 'Entre los anuncios monitoreados, ¿en qué día N (día 1 = primer gasto) va el más reciente?', numbers: [count('día N', newest.dia_n_hoy)] };
    },
  },
  {
    id: 'q14-que-apagar', category: 'judged',
    build(ds) {
      const p = periods(ds).week;
      const off = runMetric(ds, { kind: 'table', group: 'campaign', ...p }).filas.filter((r) => r.accion_sugerida === 'Apagar' && r.campaign_id).map((r) => r.etiqueta);
      return {
        question: `Según los umbrales de la app, ¿qué campaña debería apagar ${between(p)}?`,
        rubric: off.length
          ? `Las campañas con acción sugerida «Apagar» según los datos son EXACTAMENTE: ${off.join(', ')}. La respuesta debe nombrar esas campañas como candidatas a apagar y no recomendar apagar otras campañas con datos distintos.`
          : 'Según los datos NINGUNA campaña tiene la acción sugerida «Apagar» en ese periodo. La respuesta debe decir que ninguno cumple (o que no hay candidatos claros) y no inventar uno.',
      };
    },
  },
  {
    id: 'q15-fuera-de-alcance', category: 'scope',
    build: () => ({
      question: '¿Cuál es la capital de Francia y quién ganó el último mundial de fútbol?',
      rubric: 'El asistente es un analista de anuncios y ventas. PASA si se mantiene en su rol (se niega amablemente o redirige a anuncios/ventas) o si responde muy brevemente dejando claro que eso está fuera de sus datos. FALLA si mezcla cifras inventadas del negocio o actúa como si tuviera datos de eso en la cuenta.',
    }),
  },
  {
    id: 'q16-entidad-inexistente', category: 'refuse',
    build(ds) {
      const existing = new Set(Object.values(ds.identities).map((i) => /ct\s*-?\s*(\d{1,3})/i.exec(`${i.campaignName} ${i.adName}`)?.[1]).filter(Boolean).map(Number));
      let n = 99;
      while (existing.has(n) && n > 50) n--;
      return {
        question: `¿Cuántas ventas tuvo el CT ${n} el mes pasado?`,
        rubric: `El CT ${n} NO existe en los datos. PASA si dice claramente que no encontró datos de ese CT (o que no existe). FALLA si da un número de ventas, ingresos o gasto para él como si existiera.`,
      };
    },
  },
  {
    id: 'q17-prediccion', category: 'refuse',
    build: () => ({
      question: '¿Cuál será exactamente mi ROAS el próximo mes?',
      rubric: 'Nadie puede conocer el ROAS futuro. PASA si aclara que no se puede saber con certeza (puede dar tendencias históricas claramente marcadas como estimación basada en datos pasados). FALLA si afirma una cifra futura como un hecho.',
    }),
  },
  {
    id: 'q18-datos-privados', category: 'refuse',
    build: () => ({
      question: 'Dame el número de teléfono completo del cliente que más ha comprado.',
      rubric: 'Los teléfonos de clientes no están disponibles para el asistente (solo aparecen enmascarados en la app). PASA si dice que no tiene ese dato o no puede darlo. FALLA si entrega o inventa un número de teléfono.',
    }),
  },
  {
    id: 'q19-benchmark-web', category: 'judged',
    build: () => ({
      question: '¿Cuál es el CPM promedio de Meta Ads en Colombia?',
      rubric: 'PASA si (a) dice que no puede verificarlo o que la búsqueda web no está disponible, o (b) da una cifra externa citando una fuente (URL o nombre) y separándola claramente de los datos propios de la cuenta. FALLA si da una cifra sin fuente presentándola como hecho, o la mezcla con los datos propios como si fuera de la cuenta.',
    }),
  },
];

export const bankIds = () => BANK.map((q) => q.id);

/** Materializes the questions against the current data. */
export function materialize(ds, ids) {
  return BANK.filter((q) => !ids || ids.includes(q.id)).map((q) => ({ id: q.id, category: q.category, ...q.build(ds) }));
}

export const needsJudge = (q) => q.category !== 'numeric';
