// The learning loop glue (impure): record recommendations with a code-computed baseline, measure real outcomes, distill
// lesson candidates, run the certification fence and the feedback signals. Pure rules live in the sibling modules.
import { createHash } from 'node:crypto';

import { addDays } from '../ads/time.js';
import { distill } from './distiller.js';
import { sanitizeLessonText } from './lesson-filter.js';
import { entityAdIds, loadDataset, windowMetrics } from './metrics.js';
import { ACTIONS, budgetChangesIn, detectFollowed, labelOutcome } from './outcome-labeler.js';
import { aggregateSignals, isChatCorrection, isReformulation, SIGNAL_WEIGHTS } from './signals.js';

export const ENTITY_TYPES = ['ct', 'ad', 'adset', 'campaign'];
export const BASELINE_DAYS = 3;
export const MAX_CERTIFIED_IN_PROMPT = 20;
export const MIN_SUPPORT_TO_CERTIFY = 3;

const round2 = (n) => Math.round(n * 100) / 100;

function brief(m) {
  return {
    days: m.days, gasto: Math.round(m.gasto), ventas: m.ventas, valor: Math.round(m.valor), roas: round2(m.roas),
    costoVenta: m.costoVenta === null ? null : Math.round(m.costoVenta), gastoDia: Math.round(m.gasto / m.days), ventasDia: round2(m.ventas / m.days),
  };
}

function entityLabel(ds, type, id) {
  if (type === 'ct') return id;
  const ids = entityAdIds(ds, type, id);
  const any = ids && [...ids][0];
  const ident = any ? ds.identities[any] : null;
  if (type === 'ad') return ident?.adName || id;
  const row = ds.insights.find((r) => (type === 'campaign' ? r.campaignId : r.adsetId) === String(id));
  return (type === 'campaign' ? row?.campaignName : row?.adsetName) || id;
}

// ---------------------------------------------------------------- recording

export function recordRecommendation({ dataDir, store, sessionId, args, now = Date.now(), dataset }) {
  const entityType = String(args.entity_type ?? '').toLowerCase();
  const action = String(args.action ?? '').toLowerCase();
  if (!ENTITY_TYPES.includes(entityType)) return { error: `entity_type debe ser uno de: ${ENTITY_TYPES.join(', ')}.` };
  if (!ACTIONS.includes(action)) return { error: `action debe ser uno de: ${ACTIONS.join(', ')}.` };
  const entityId = String(args.entity_id ?? '').trim();
  if (!entityId || entityId.length > 80) return { error: 'entity_id es obligatorio (código CT, id de anuncio, conjunto o campaña).' };
  const params = {};
  if (args.params && typeof args.params === 'object') {
    if (args.params.pct !== undefined) {
      const pct = Number(args.params.pct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 500) return { error: 'params.pct debe ser un número entre 0 y 500.' };
      params.pct = pct;
    }
  }
  const evalAfterDays = args.eval_after_days === undefined ? 3 : Math.floor(Number(args.eval_after_days));
  if (!Number.isFinite(evalAfterDays) || evalAfterDays < 2 || evalAfterDays > 14) return { error: 'eval_after_days debe estar entre 2 y 14.' };

  const ds = dataset ?? loadDataset(dataDir, now);
  const id = entityType === 'ct' ? canonicalCt(entityId) : entityId.replace(/\s+/g, '');
  const ids = entityAdIds(ds, entityType, id);
  if (!ids || !ids.size) return { error: `No encuentro datos de ${entityType} «${entityId}». Verifica el código o el id.` };

  const to = addDays(ds.today, -1);
  const from = addDays(to, -(BASELINE_DAYS - 1));
  const w = windowMetrics(ds, { entityType, entityId: id, from, to });
  if (!w) return { error: 'No se pudo calcular la línea base.' };
  const baseline = { from, to, ...brief(w) };

  const existing = store.findPendingRecommendation(sessionId, entityType, id, action, ds.today);
  if (existing) return { id: existing, repetida: true, linea_base: baseline };
  const recId = store.addRecommendation({
    recDate: ds.today, sessionId, entityType, entityId: id, entityLabel: entityLabel(ds, entityType, id), action, params, rationale: String(args.rationale ?? '').slice(0, 500), baseline, evalAfterDays,
  });
  return {
    id: recId, registrada: true, linea_base: baseline,
    se_medira_el: addDays(ds.today, evalAfterDays + 1),
    nota: `El sistema medirá el resultado real ${evalAfterDays} días después y lo comparará con esta línea base.`,
  };
}

const canonicalCt = (value) => {
  const m = /(\d{1,3})/.exec(String(value));
  return m ? `CT ${m[1].padStart(2, '0')}` : String(value);
};

// ---------------------------------------------------------------- measuring

function statusesOf(ds, adIds) {
  return [...adIds].map((id) => ds.ads[id]?.effectiveStatus).filter(Boolean);
}

function evaluate(ds, rec) {
  const afterFrom = addDays(rec.recDate, 1);
  const afterTo = addDays(rec.recDate, rec.evalAfterDays);
  const adIds = entityAdIds(ds, rec.entityType, rec.entityId);
  const after = adIds?.size ? windowMetrics(ds, { entityType: rec.entityType, entityId: rec.entityId, from: afterFrom, to: afterTo }) : null;
  const baseline = rec.baseline;

  // Budget changes on the ad sets / campaigns of the entity during the after-window.
  const entities = [];
  if (rec.entityType === 'adset' || rec.entityType === 'campaign') entities.push({ type: rec.entityType, id: rec.entityId });
  else {
    for (const row of ds.insights) {
      if (!adIds?.has(row.adId)) continue;
      entities.push({ type: 'adset', id: row.adsetId }, { type: 'campaign', id: row.campaignId });
    }
  }
  const uniq = [...new Map(entities.map((e) => [`${e.type}|${e.id}`, e])).values()];
  const changes = budgetChangesIn({ events: ds.events, histories: ds.histories, entities: uniq, from: afterFrom, to: afterTo });
  const newAds = rec.entityType === 'ct' || rec.entityType === 'campaign'
    ? [...new Set(ds.insights.map((r) => r.adId))].filter((id) => {
        const first = ds.ads[id]?.firstSpendDate;
        if (!first || first < afterFrom || first > afterTo || adIds?.has(id)) return false;
        const ident = ds.identities[id];
        return rec.entityType === 'ct' ? canonicalCt(ident?.campaignName ?? '') === rec.entityId || canonicalCt(ident?.adName ?? '') === rec.entityId : ident?.campaignId === rec.entityId;
      }).length
    : 0;

  const followed = after ? detectFollowed({ action: rec.action, baseline, after, changes, newAds, statuses: statusesOf(ds, adIds) }) : 'unknown';
  const { label, explanation } = labelOutcome({ action: rec.action, baseline, after: after && { ...after }, followed, minSpend: ds.config.thresholds.minSpend });
  return { label, explanation, followed, after: after ? { from: afterFrom, to: afterTo, ...brief(after) } : { from: afterFrom, to: afterTo } };
}

/**
 * Daily cycle: measure due recommendations, then re-distill lesson candidates. Idempotent. `force` ignores the
 * once-a-day guard (the "Medir ahora" button).
 */
export function runLearningCycle({ dataDir, store, now = Date.now(), force = false, dataset }) {
  const ds = dataset ?? loadDataset(dataDir, now);
  if (!force && store.getKv('learningLastRun') === ds.today) return { skipped: 'ya corrió hoy', evaluated: 0, candidates: 0 };
  let evaluated = 0;
  for (const rec of store.pendingRecommendations()) {
    if (!(ds.today > addDays(rec.recDate, rec.evalAfterDays))) continue;
    const res = evaluate(ds, rec);
    store.saveOutcome({ recId: rec.id, afterJson: res.after, label: res.label, explanation: res.explanation, followed: res.followed });
    if (res.followed === 'yes') store.addSignal({ sessionId: rec.sessionId, messageId: rec.messageId, kind: 'recomendacion_seguida', weight: SIGNAL_WEIGHTS.recomendacion_seguida, note: `${rec.action} ${rec.entityId}` });
    evaluated++;
  }
  const candidates = distillAndStore(store);
  store.setKv('learningLastRun', ds.today);
  return { evaluated, candidates, today: ds.today };
}

export function distillAndStore(store) {
  return storeCandidates(store, distill(store.labeledOutcomes()));
}

/** Stores distilled candidates idempotently by key (shared by every agent's distiller). */
export function storeCandidates(store, candidates) {
  let created = 0;
  for (const c of candidates) {
    const cur = store.getLessonByKey(c.key);
    if (!cur) {
      store.insertLesson(c);
      created++;
    } else if (cur.status === 'candidate') store.updateLesson(cur.id, { text: c.text, evidence: c.evidence, weight: c.weight });
    else if (cur.status === 'certified') store.updateLesson(cur.id, { evidence: c.evidence, weight: c.weight }); // never rewrites a certified text
    // rejected: stays rejected, evidence is not resurrected
  }
  return created;
}

// ---------------------------------------------------------------- lessons and the certification fence

export const certifiedLessons = (store) =>
  store.lessons('certified').sort((a, b) => b.weight - a.weight || (b.certifiedAt ?? 0) - (a.certifiedAt ?? 0)).slice(0, MAX_CERTIFIED_IN_PROMPT);

/** Fail-closed: even a human cannot certify thin evidence or text that does not pass the filter. */
export function canCertify(lesson) {
  if (lesson.kind === 'rule' && lesson.source === 'distiller' && (lesson.evidence?.support ?? 0) < MIN_SUPPORT_TO_CERTIFY) return { ok: false, reason: 'La evidencia es muy poca (mínimo 3 casos).' };
  const check = sanitizeLessonText(lesson.text, { trusted: lesson.source === 'user' || lesson.source === 'distiller' });
  return check.ok ? { ok: true } : { ok: false, reason: `El texto ${check.reason}.` };
}

export function setLessonStatus(store, id, action, now = Date.now()) {
  const lesson = store.getLesson(id);
  if (!lesson) return { error: 'No encuentro esa lección.' };
  if (action === 'certify') {
    const fence = canCertify(lesson);
    if (!fence.ok) return { error: fence.reason };
    store.updateLesson(id, { status: 'certified', certifiedAt: now, shown: true });
  } else if (action === 'reject') store.updateLesson(id, { status: 'rejected', shown: true });
  else if (action === 'revoke') store.updateLesson(id, { status: 'rejected' });
  else if (action === 'restore') store.updateLesson(id, { status: 'candidate', certifiedAt: null });
  else return { error: 'Acción no válida.' };
  return { lesson: store.getLesson(id) };
}

export function editLesson(store, id, text) {
  const lesson = store.getLesson(id);
  if (!lesson) return { error: 'No encuentro esa lección.' };
  const check = sanitizeLessonText(text, { trusted: true });
  if (!check.ok) return { error: `El texto ${check.reason}.` };
  store.updateLesson(id, { text: check.text });
  return { lesson: store.getLesson(id) };
}

const hash = (s) => createHash('sha1').update(String(s).toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 12);

/** The agent may PROPOSE a lesson; it is always a candidate and must look like an observed fact. */
export function proposeLesson(store, text, evidence = {}) {
  const check = sanitizeLessonText(text);
  if (!check.ok) return { error: `No puedo proponer esa lección: ${check.reason}.` };
  const key = `agent:${hash(check.text)}`;
  const cur = store.getLessonByKey(key);
  if (cur) return { id: cur.id, estado: cur.status, repetida: true };
  const id = store.insertLesson({ key, text: check.text, kind: 'agent', source: 'agent', scope: 'agent', weight: 1, evidence: { support: Number(evidence.support) || 0, nota: String(evidence.nota ?? '').slice(0, 200) } });
  return { id, estado: 'candidate', nota: 'Quedó como candidata: el usuario decide si se aprende.' };
}

const normalizeQuote = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A rule the USER stated explicitly in this chat. The agent only transcribes it: the quote must literally appear in one of the
 * user's messages of the session (checked here, not by the model). It is a candidate like any other lesson, but as a user rule
 * it needs no minimum number of cases to be certified (see canCertify).
 */
export function proposeUserRule(store, { sessionId, text, quote }) {
  const q = normalizeQuote(quote);
  if (q.length < 20 || q.split(' ').length < 4) return { error: 'Indica en quote la frase textual del usuario (mínimo 4 palabras y 20 caracteres).' };
  const said = sessionId ? store.messages(sessionId).filter((m) => m.role === 'user').some((m) => ` ${normalizeQuote(m.text)} `.includes(` ${q} `)) : false;
  if (!said) return { error: 'No encuentro esa frase en lo que escribió el usuario en este chat. Solo puedo registrar reglas que dijo textualmente.' };
  const check = sanitizeLessonText(text, { trusted: true });
  if (!check.ok) return { error: `No puedo registrar esa regla: ${check.reason}.` };
  const key = `user:${hash(check.text)}`;
  const cur = store.getLessonByKey(key);
  if (cur) return { id: cur.id, estado: cur.status, repetida: true };
  const id = store.insertLesson({ key, text: check.text, kind: 'rule', source: 'user', scope: 'reglas', weight: 3, evidence: { support: 1, quote: String(quote).slice(0, 200) } });
  return { id, estado: 'candidate', nota: 'Quedó como candidata: el usuario confirma con «¿Aprendo esto?» en la pestaña Lecciones.' };
}

// ---------------------------------------------------------------- feedback

const RATING_KINDS = ['pulgar_arriba', 'pulgar_abajo', 'correccion'];

export function recordFeedback(store, { messageId, kind, comment = '' }) {
  const msg = store.getMessage(messageId);
  if (!msg || msg.role !== 'assistant') return { error: 'No encuentro esa respuesta.' };
  const map = { up: ['pulgar_arriba', 1], down: ['pulgar_abajo', -1], wrong: ['correccion', -1] };
  if (!map[kind]) return { error: 'Tipo de retroalimentación no válido.' };
  const [signal, rating] = map[kind];
  const note = String(comment ?? '').trim().slice(0, 300);
  store.removeSignals(messageId, RATING_KINDS);
  store.addSignal({ sessionId: msg.sessionId, messageId, kind: signal, weight: SIGNAL_WEIGHTS[signal], note: note || null });
  store.updateMessage(messageId, { meta: { ...msg.meta, rating, ...(note ? { comment: note } : {}) } });
  let candidate = null;
  if (kind === 'wrong' && note) {
    const check = sanitizeLessonText(`Preferencia del usuario: ${note}`, { trusted: true });
    if (check.ok) {
      const key = `pref:${hash(note)}`;
      if (!store.getLessonByKey(key)) candidate = store.insertLesson({ key, text: check.text, kind: 'preference', source: 'user', scope: 'respuestas', weight: 1, evidence: { support: 1, messageId } });
    }
  }
  return { rating, candidateId: candidate };
}

export function noteReformulation(store, { sessionId, userMessageId, text, now = Date.now() }) {
  const msgs = store.messages(sessionId);
  const prevUserIdx = msgs.findLastIndex((m) => m.role === 'user' && m.id < userMessageId);
  if (prevUserIdx < 0) return false;
  const prev = msgs[prevUserIdx];
  const answered = msgs.slice(prevUserIdx).find((m) => m.role === 'assistant');
  if (!answered || !isReformulation({ ts: prev.ts, text: prev.text }, { ts: now, text })) return false;
  store.addSignal({ sessionId, messageId: answered.id, kind: 'reformulacion', weight: SIGNAL_WEIGHTS.reformulacion });
  return true;
}

/** A chat message that pushes back on the previous answer counts as a weak correction signal on it. */
export function noteCorrection(store, { sessionId, userMessageId, text }) {
  if (!isChatCorrection(text)) return false;
  const msgs = store.messages(sessionId);
  const prev = msgs.findLast((m) => m.role === 'assistant' && m.id < userMessageId);
  if (!prev) return false;
  store.addSignal({ sessionId, messageId: prev.id, kind: 'correccion_en_chat', weight: SIGNAL_WEIGHTS.correccion_en_chat, note: String(text).replace(/s+/g, ' ').trim().slice(0, 200) });
  return true;
}

export function learningSummary(store, now = Date.now()) {
  const lessons = store.lessons();
  const outcomes = store.labeledOutcomes();
  const labels = { acierto: 0, fallo: 0, neutral: 0, sin_datos: 0 };
  for (const o of outcomes) labels[o.outcome.label] = (labels[o.outcome.label] ?? 0) + 1;
  return {
    lessons: { candidate: lessons.filter((l) => l.status === 'candidate').length, certified: lessons.filter((l) => l.status === 'certified').length, rejected: lessons.filter((l) => l.status === 'rejected').length },
    outcomes: labels,
    pending: store.pendingRecommendations().length,
    signals: aggregateSignals(store.signals(now - 180 * 86_400_000), now),
  };
}

// ---------------------------------------------------------------- hooks for the turn runner

/**
 * Hooks of the turn runner. `profile` parametrizes the loop per agent (the Analista passes nothing and behaves as always):
 *   refresh({ store })   re-reads the agent's own outcomes and stores new lesson candidates (creativo, investigador)
 *   chatCorrections      also count "no, así no" style messages as weak correction signals
 */
export function makeHooks(profile = {}) {
  return {
    lessons: ({ store }) => certifiedLessons(store),
    onUserMessage: ({ store, sessionId, userMessageId, text }) => {
      try {
        if (profile.chatCorrections) noteCorrection(store, { sessionId, userMessageId, text });
        noteReformulation(store, { sessionId, userMessageId, text });
      } catch {
        /* learning must never break a turn */
      }
    },
    onTurnDone: ({ store, dataDir, sessionId, messageId, meta }) => {
      try {
        store.attachRecommendations(sessionId, messageId);
        try {
          profile.refresh?.({ store, dataDir });
        } catch {
          /* a failing distiller must not hide the answer */
        }
        if (meta.ungrounded?.length) store.addSignal({ sessionId, messageId, kind: 'cifra_sin_fuente', weight: SIGNAL_WEIGHTS.cifra_sin_fuente, note: meta.ungrounded.join(', ').slice(0, 200) });
        const fresh = store.unshownCandidates();
        store.markShown(fresh.map((l) => l.id));
        return { newCandidates: fresh.length, candidateIds: fresh.map((l) => l.id) };
      } catch {
        return { newCandidates: 0 };
      }
    },
  };
}

