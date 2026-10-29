// Deterministic, idempotent distiller (adapted from Leasify's destilador): turns labeled outcomes into lesson
// CANDIDATES with their evidence counts. Same input => same candidates (stable keys), so re-running never duplicates.
// Only acierto / fallo of recommendations that were not ignored count. Ambiguous groups produce nothing.
export const MIN_EVIDENCE = 3;
export const STRONG = 0.75;

const NAMES = {
  escalar: 'Recomendar «escalar»',
  duplicar: 'Recomendar «duplicar»',
  mantener: 'Recomendar «mantener»',
  bajar: 'Bajar el presupuesto',
  apagar: 'Mantener encendido algo que se recomendó apagar',
};

// Which lesson group a recommendation belongs to.
export function groupOf(rec) {
  if (rec.action === 'subir_presupuesto' || (rec.action === 'escalar' && Number.isFinite(rec.params?.pct))) {
    const pct = Number(rec.params?.pct);
    if (Number.isFinite(pct)) return { id: pct > 20 ? 'raise:gt20' : 'raise:le20', kind: 'raise', big: pct > 20 };
    return { id: 'raise:any', kind: 'raise', big: null };
  }
  return { id: `${rec.action}:any`, kind: rec.action };
}

function phrase(group, direction, a, f, n) {
  const times = (k) => `${k} de ${n} ${n === 1 ? 'vez' : 'veces'}`;
  if (group.kind === 'raise') {
    const what = group.big === true ? 'Subir el presupuesto más de 20 % de una vez' : group.big === false ? 'Subir el presupuesto hasta 20 % de una vez' : 'Subir el presupuesto';
    return direction === 'neg' ? `${what} falló ${times(f)} (el ROAS no se sostuvo).` : `${what} funcionó ${times(a)} (el ROAS se sostuvo).`;
  }
  if (group.kind === 'bajar') return direction === 'neg' ? `Bajar el presupuesto empeoró el resultado diario ${times(f)}.` : `Bajar el presupuesto mejoró el resultado diario ${times(a)}.`;
  if (group.kind === 'apagar') return direction === 'pos' ? `Cuando se mantuvo encendido algo que se recomendó apagar, siguió perdiendo ${times(a)}.` : `Cuando se mantuvo encendido algo que se recomendó apagar, se recuperó ${times(f)}.`;
  const name = NAMES[group.kind] ?? `La acción «${group.kind}»`;
  return direction === 'neg' ? `${name} falló ${times(f)}.` : `${name} funcionó ${times(a)}.`;
}

/**
 * @param {{ id: number, action: string, params: object, followed: string, outcome: { label: string } | null }[]} recs
 * @returns {{ key: string, text: string, scope: string, kind: 'rule', source: 'distiller', weight: number, evidence: object }[]}
 */
export function distill(recs, { minEvidence = MIN_EVIDENCE, strong = STRONG } = {}) {
  const groups = new Map();
  for (const rec of recs) {
    const label = rec.outcome?.label;
    if (label !== 'acierto' && label !== 'fallo') continue;
    if (rec.followed === 'no' && rec.action !== 'apagar') continue;
    const g = groupOf(rec);
    const entry = groups.get(g.id) ?? { group: g, acierto: 0, fallo: 0, recIds: [] };
    entry[label] += 1;
    entry.recIds.push(rec.id);
    groups.set(g.id, entry);
  }
  const out = [];
  for (const [id, e] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = e.acierto + e.fallo;
    if (n < minEvidence) continue;
    const direction = e.fallo / n >= strong ? 'neg' : e.acierto / n >= strong ? 'pos' : null;
    if (!direction) continue;
    out.push({
      key: `rule:${id}:${direction}`,
      text: phrase(e.group, direction, e.acierto, e.fallo, n),
      scope: id,
      kind: 'rule',
      source: 'distiller',
      weight: n,
      evidence: { support: n, acierto: e.acierto, fallo: e.fallo, recIds: e.recIds },
    });
  }
  return out;
}
