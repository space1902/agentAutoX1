// Health and "line strength" per WhatsApp number (traffic light + score 0-100).
// Pure functions: everything comes in as plain data, so it is unit tested. The formula is documented
// in the README ("Line health"). These are community heuristics, NOT official WhatsApp limits.
import { classifyPhase, daysSince, earliestCsvDate, summarizeIncidents } from './health-metrics.js';

export const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SEVERE_WINDOW_MS = 72 * HOUR_MS;

export const MAX_POINTS = { age: 35, volume: 20, reciprocity: 15, stability: 20, recency: 10 };
const AGE_FULL_DAYS = 14;
const VOLUME_FULL_MESSAGES = 60;
const GREEN_FROM = 70;
const YELLOW_FROM = 40;

const num = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function component(key, label, points, detail) {
  return { key, label, points, max: MAX_POINTS[key], detail };
}

// input: { linked, days, sent, received, lastActivityAt, disconnected, relinks, authFailures, severeRecent }
export function scoreLine(input, now = new Date()) {
  const linked = Boolean(input?.linked);
  const days = num(input?.days);
  const sent = num(input?.sent);
  const received = num(input?.received);
  const disconnected = num(input?.disconnected);
  const relinks = num(input?.relinks);
  const authFailures = num(input?.authFailures);
  const severeRecent = Boolean(input?.severeRecent);
  const phase = classifyPhase(days);

  if (!linked) {
    return {
      score: 0,
      light: 'rojo',
      linked: false,
      phase,
      severeRecent,
      components: Object.keys(MAX_POINTS).map((key) => component(key, LABELS[key], 0, 'Sin vincular')),
      reasons: ['El número no está vinculado: vincúlalo para poder calentarlo.'],
    };
  }

  const lastMs = input?.lastActivityAt ? new Date(input.lastActivityAt).getTime() : NaN;
  const idleHours = Number.isNaN(lastMs) ? Infinity : (now.getTime() - lastMs) / HOUR_MS;

  const age = Math.round((Math.min(days, AGE_FULL_DAYS) / AGE_FULL_DAYS) * MAX_POINTS.age);
  const volume = Math.round((Math.min(sent + received, VOLUME_FULL_MESSAGES) / VOLUME_FULL_MESSAGES) * MAX_POINTS.volume);
  const reciprocity = sent === 0 ? 0 : Math.round(Math.min(received / sent, 1) * MAX_POINTS.reciprocity);
  const penalty = Math.min(12, 4 * disconnected) + 10 * relinks + 10 * authFailures;
  const stability = clamp(MAX_POINTS.stability - penalty, 0, MAX_POINTS.stability);
  const recency = idleHours <= 24 ? 10 : idleHours <= 72 ? 6 : idleHours <= 168 ? 3 : 0;

  const components = [
    component('age', LABELS.age, age, `${days} día(s) de historia (${AGE_FULL_DAYS} o más dan el máximo)`),
    component('volume', LABELS.volume, volume, `${sent + received} mensajes en ${WINDOW_DAYS} días (${VOLUME_FULL_MESSAGES} dan el máximo)`),
    component(
      'reciprocity',
      LABELS.reciprocity,
      reciprocity,
      sent === 0 ? 'Aún no ha enviado mensajes' : `${received} recibidos por ${sent} enviados`,
    ),
    component(
      'stability',
      LABELS.stability,
      stability,
      penalty === 0
        ? 'Sin desconexiones ni re-vinculaciones'
        : `${disconnected} desconexión(es), ${relinks} re-vinculación(es), ${authFailures} fallo(s) de autenticación`,
    ),
    component(
      'recency',
      LABELS.recency,
      recency,
      idleHours === Infinity ? 'Sin actividad registrada' : `Última actividad hace ${formatIdle(idleHours)}`,
    ),
  ];

  const score = clamp(
    components.reduce((sum, c) => sum + c.points, 0),
    0,
    100,
  );
  const reasons = [];
  if (severeRecent) reasons.push('WhatsApp cerró la sesión o falló la autenticación en las últimas 72 horas.');
  if (days < 4) reasons.push('Línea nueva: en los primeros días es frágil, mantén la actividad baja.');
  if (idleHours > 168) reasons.push('Lleva más de 7 días sin actividad.');
  if (disconnected >= 3) reasons.push('Se desconectó varias veces: revisa el proxy o la red.');

  const light = severeRecent ? 'rojo' : score >= GREEN_FROM ? 'verde' : score >= YELLOW_FROM ? 'amarillo' : 'rojo';
  return { score, light, linked: true, phase, severeRecent, components, reasons };
}

const LABELS = {
  age: 'Antigüedad',
  volume: 'Volumen de mensajes',
  reciprocity: 'Respuestas recibidas',
  stability: 'Estabilidad',
  recency: 'Actividad reciente',
};

function formatIdle(hours) {
  if (hours < 1) return 'menos de 1 hora';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} días`;
}

// Raw data -> one health entry per tester id. Readers are injected (the CLI reads the data dir).
//   activityOf(id, sinceSeconds) -> { messages: [{ fromMe, timestamp }], earliestSent }
export function buildLineHealth({ testerIds, linkedOf, events = [], activityOf, csvTexts = [], now = new Date() }) {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const sinceSeconds = since.getTime() / 1000;
  const out = {};

  for (const id of testerIds) {
    const activity = activityOf(id, sinceSeconds) ?? { messages: [], earliestSent: null };
    const messages = (activity.messages ?? []).filter((m) => m.timestamp >= sinceSeconds);
    const sent = messages.filter((m) => m.fromMe).length;
    const received = messages.length - sent;
    const lastSeconds = messages.reduce((max, m) => Math.max(max, m.timestamp), 0);

    const own = events.filter((e) => e.session === id);
    const firstReady = own.find((e) => e.event === 'ready')?.at;
    const firstActivityAt =
      [
        firstReady,
        earliestCsvDate(csvTexts, id),
        activity.earliestSent ? new Date(activity.earliestSent * 1000).toISOString() : null,
      ]
        .filter(Boolean)
        .sort((a, b) => new Date(a) - new Date(b))[0] ?? null;

    const incidents = summarizeIncidents(events, id, since);
    const loggedOut = own.filter((e) => e.event === 'logged_out_relink' && new Date(e.at) >= since).length;
    const relinks = Math.max(incidents.qr, loggedOut);
    const severeSince = now.getTime() - SEVERE_WINDOW_MS;
    // A pause because WhatsApp ended the session replaces the old automatic relink as the "severe" signal.
    // It only sets this flag: it never adds to the disconnect or relink counts (the LOGOUT disconnect is
    // already one incident), so nothing is counted twice.
    const severeRecent = own.some(
      (e) =>
        (e.event === 'auth_failure' ||
          e.event === 'logged_out_relink' ||
          (e.event === 'paused' && String(e.detail ?? '').startsWith('logged_out'))) &&
        new Date(e.at).getTime() >= severeSince,
    );

    const stats = {
      days: daysSince(firstActivityAt, now),
      firstActivityAt,
      sent,
      received,
      lastActivityAt: lastSeconds ? new Date(lastSeconds * 1000).toISOString() : null,
      disconnected: incidents.disconnected,
      relinks,
      authFailures: incidents.auth_failure,
    };
    const scored = scoreLine({ ...stats, linked: Boolean(linkedOf(id)), severeRecent }, now);
    out[id] = { ...scored, stats };
  }
  return out;
}
