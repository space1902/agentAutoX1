// WhatsApp message text. Pure formatting. Everything the user reads is neutral Spanish with "tu"
// (tuteo), never voseo.

export function formatMoney(n) {
  const rounded = Math.round(Number(n) || 0);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${rounded < 0 ? '-' : ''}$${digits}`;
}

const num = (n, digits = 1) => Number(n).toFixed(digits).replace('.', ',');
const quote = (name) => `«${name}»`;
// Text for an action failure: Meta's own user-facing explanation when it sent one.
export function errorText(error) {
  const title = error?.userTitle;
  const msg = error?.userMessage;
  if (title && msg) return `${title}: ${msg}`;
  return msg ?? title ?? error?.message ?? String(error);
}

const COLOR = { green: '🟢', yellow: '🟡', red: '🔴', none: '⚪' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ttlText(ttlMin) {
  if (!ttlMin) return '';
  return ttlMin % 60 === 0 ? `${ttlMin / 60} ${ttlMin === 60 ? 'hora' : 'horas'}` : `${ttlMin} min`;
}

function approvalFooter(requestId, ttlMin) {
  const ttl = ttlText(ttlMin);
  return `Responde SI ${requestId} para confirmar o NO ${requestId} para dejarlo así.${ttl ? ` La solicitud vence en ${ttl}.` : ''}`;
}

export function formatAlert(alert, { requestId = null, ttlMin = null } = {}) {
  switch (alert.type) {
    case 'ad_no_sale': {
      if (alert.level === 'action') {
        const limit = alert.thresholds ? ` (límite ${formatMoney(alert.thresholds.review)})` : '';
        const head = `🔴 El anuncio ${quote(alert.adName)} gastó ${formatMoney(alert.spentSinceSale)} desde su última venta sin vender${limit}. ¿Pausamos el conjunto del anuncio ${quote(alert.adName)}?`;
        return requestId ? `${head}\n${approvalFooter(requestId, ttlMin)}` : `${head}\nRevísalo en el Administrador de anuncios.`;
      }
      const goal = alert.thresholds ? ` Tu objetivo de CPA es ${formatMoney(alert.thresholds.target)}.` : '';
      return `🟡 Preocupación: el anuncio ${quote(alert.adName)} ya gastó ${formatMoney(alert.spentSinceSale)} desde su última venta y no ha vendido.${goal}`;
    }
    case 'account_gap': {
      if (alert.level === 'action') {
        const head = `🔴 Llevamos ${alert.minutes} minutos sin ventas en toda la cuenta (umbral ${alert.thresholdMin} min).`;
        if (requestId && alert.actions?.length) {
          const list = alert.actions.map((a) => `• el conjunto del anuncio ${quote(a.label)}`).join('\n');
          return `${head}\nTe sugiero pausar el conjunto de estos anuncios:\n${list}\n${approvalFooter(requestId, ttlMin)}`;
        }
        return `${head}\nNo veo un anuncio claro para pausar; revisa la cuenta y decide si hay que actuar.`;
      }
      return `🟡 Preocupación: llevamos ${alert.minutes} minutos sin ventas en ningún anuncio (umbral ${alert.thresholdMin} min).`;
    }
    case 'ad_status': {
      const what = alert.status === 'DISAPPROVED' ? 'fue rechazado' : 'tiene problemas';
      return `🚨 El anuncio ${quote(alert.adName)} ${what} (${alert.status}). Revísalo en el Administrador de anuncios.`;
    }
    case 'account_status':
      return `🚨 La cuenta publicitaria no está activa (estado ${alert.status}, motivo ${alert.disableReason ?? 0}). Tus anuncios pueden haberse detenido; revisa la cuenta ya.`;
    case 'spend_cap':
      return `🚨 La cuenta alcanzó su límite de gasto (${formatMoney(alert.amountSpent)} de ${formatMoney(alert.spendCap)}). No se entregarán anuncios hasta que lo subas.`;
    case 'ad_no_spend':
      return `🟡 El anuncio ${quote(alert.adName)} está activo pero no ha gastado nada en las últimas ${alert.hours} horas. Puede estar en revisión, sin presupuesto o sin entrega.`;
    case 'pixel_suspect':
      return `🚨 Hay ${alert.conversations} conversaciones iniciadas en las últimas ${alert.hours} horas y cero compras registradas. Revisa si el píxel o el seguimiento de compras dejó de funcionar.`;
    case 'cost_per_conversation':
      return `🟡 El costo por conversación de ${quote(alert.adName)} está en ${formatMoney(alert.current)}, ${num(alert.current / alert.baseline)} veces su promedio de 5 días (${formatMoney(alert.baseline)}).`;
    case 'frequency':
      return `🟡 La frecuencia de ${quote(alert.adName)} es ${num(alert.frequency)} (límite ${num(alert.limit)}). La audiencia ya vio mucho el anuncio; considera renovar el creativo.`;
    case 'ctr_drop':
      return `🟡 El CTR de ${quote(alert.adName)} bajó a ${num(alert.current, 2)} % (su promedio de 5 días es ${num(alert.baseline, 2)} %).`;
    case 'cpm_rise':
      return `🟡 El CPM de ${quote(alert.adName)} subió a ${formatMoney(alert.current)} (su promedio de 5 días es ${formatMoney(alert.baseline)}).`;
    default:
      return `⚠️ Alerta: ${alert.type}`;
  }
}

export function formatSummary(summary, { hourLabel }) {
  const title = `📊 Resumen de las ${hourLabel}`;
  if (summary.rows.length === 0) return `${title}\nSin gasto ni actividad en los anuncios hoy.`;
  const lines = summary.rows.map((r) => {
    const sales = plural(r.purchases, 'venta', 'ventas');
    const cpa = r.cpa != null ? `CPA ${formatMoney(r.cpa)}` : 'sin ventas';
    return `${COLOR[r.color]} ${r.adName}: ${sales} · gasto ${formatMoney(r.spend)} · ${cpa}`;
  });
  const t = summary.totals;
  const total = `Total hoy: ${plural(t.purchases, 'venta', 'ventas')} · gasto ${formatMoney(t.spend)} · ${t.cpa != null ? `CPA ${formatMoney(t.cpa)}` : 'sin CPA'} ${COLOR[t.color]}`;
  return [title, ...lines, total].join('\n');
}

const THRESHOLD_LABELS = {
  targetCpa: { label: 'CPA objetivo (verde)', command: 'objetivo', unit: 'money' },
  reviewCpa: { label: 'CPA de revisión (rojo desde aquí)', command: 'revisar', unit: 'money' },
  gapWorryMin: { label: 'Minutos sin ventas para preocuparme', command: 'preocupacion', unit: 'min' },
  gapActionMin: { label: 'Minutos sin ventas para pedirte una acción', command: 'accion', unit: 'min' },
  frequencyMax: { label: 'Frecuencia máxima', command: 'frecuencia', unit: 'plain' },
};

export function formatThresholdValue(name, value) {
  const unit = THRESHOLD_LABELS[name]?.unit ?? 'plain';
  if (unit === 'money') return formatMoney(value);
  if (unit === 'min') return `${value} min`;
  return String(value).replace('.', ',');
}

export function formatRecommendation(recs, { id, days }) {
  const lines = recs.map((r) => {
    const meta = THRESHOLD_LABELS[r.name] ?? { label: r.name, command: r.name };
    return `• ${meta.label}: ahora ${formatThresholdValue(r.name, r.current)} → recomendado ${formatThresholdValue(r.name, r.recommended)} (valor ${meta.command} ${r.recommended})`;
  });
  return [
    `📈 Revisión de umbrales con los últimos ${days} días`,
    ...lines,
    `Para aplicar todo responde ACEPTAR ${id}. Para cambiar uno solo, escribe por ejemplo: valor ${(THRESHOLD_LABELS[recs[0]?.name]?.command) ?? 'objetivo'} ${recs[0]?.recommended ?? 3000}.`,
    'No cambio nada hasta que me lo confirmes.',
  ].join('\n');
}

export function formatStatus({ config, summary, minutesSinceSale, pending, alertsPausedMin, accessTier = null }) {
  const t = config.thresholds;
  const mode = config.mode === 'autonomous' ? 'autónomo (aún solo alertas)' : 'solo alertas (alert_only)';
  const lines = [
    '🧭 Estado de la cuenta',
    `Modo: ${mode}${config.killSwitch ? ' · ACCIONES DETENIDAS (escribe REANUDAR para volver)' : ''}`,
    summary.rows.length === 0
      ? 'Hoy: sin gasto ni actividad.'
      : `Hoy: ${plural(summary.totals.purchases, 'venta', 'ventas')} · gasto ${formatMoney(summary.totals.spend)} · ${summary.totals.cpa != null ? `CPA ${formatMoney(summary.totals.cpa)}` : 'sin CPA'} ${COLOR[summary.totals.color]}`,
    minutesSinceSale == null ? 'Última venta: aún sin ventas hoy.' : `Última venta: hace ${minutesSinceSale} min.`,
    `Umbrales: objetivo ${formatMoney(t.targetCpa)} · revisar ${formatMoney(t.reviewCpa)} · sin ventas ${t.gapWorryMin}/${t.gapActionMin} min · frecuencia ${num(t.frequencyMax)}`,
  ];
  if (accessTier) lines.push(`Nivel de acceso a la API de Meta: ${accessTier}${accessTier === 'development_access' ? ' (las acciones se ejecutan con 35 s entre una y otra)' : ''}`);
  if (pending.length > 0) lines.push(`Solicitudes pendientes: ${pending.map((p) => `#${p.id} ${p.label}`).join(', ')}`);
  if (alertsPausedMin > 0) lines.push(`Alertas en pausa por ${alertsPausedMin} min más.`);
  return lines.join('\n');
}

export function formatHelp() {
  return [
    'Comandos disponibles:',
    '• SI <id> / NO <id>: aprueba o rechaza una solicitud de acción.',
    '• ACEPTAR <id>: aplica una recomendación de umbrales.',
    '• valor <nombre> <número>: cambia un umbral (objetivo, revisar, preocupacion, accion, frecuencia). Ejemplo: valor revisar 3000',
    '• estado: resumen actual.',
    '• pausa alertas <min>: silencia las alertas por ese tiempo (0 las reactiva).',
    '• DETENER: bloquea toda acción sobre los anuncios. REANUDAR la habilita de nuevo.',
    '• ayuda: este mensaje.',
  ].join('\n');
}

export const replies = {
  executed: ({ id, labels }) => `✅ Solicitud ${id} ejecutada: ${labels.join(', ')}.`,
  failed: ({ id, error }) => `⚠️ No pude ejecutar la solicitud ${id}: ${error}`,
  expired: (id) => `⌛ La solicitud ${id} expiró (pasaron más de 2 horas). Si sigue siendo necesario, espera la próxima alerta.`,
  notFound: (id) => `No encuentro la solicitud ${id}.`,
  alreadyHandled: (id, status) => `La solicitud ${id} ya estaba en estado "${status}".`,
  queued: ({ id, untilHour }) => `⏳ Entendido. La solicitud ${id} queda en cola: estamos en horario restringido y la ejecutaré a partir de las ${String(untilHour).padStart(2, '0')}:00.`,
  killSwitch: () => '🛑 Las acciones están detenidas (comando DETENER activo). Escribe REANUDAR si quieres habilitarlas de nuevo.',
  rejected: (id) => `Listo, la solicitud ${id} queda rechazada. No toqué nada.`,
  thresholdSet: ({ name, value }) => `✅ Listo: ${THRESHOLD_LABELS[name]?.label ?? name} ahora es ${formatThresholdValue(name, value)}.`,
  thresholdError: (code) =>
    ({
      unknown: 'No conozco ese umbral. Prueba con: objetivo, revisar, preocupacion, accion o frecuencia.',
      not_positive: 'El valor debe ser un número mayor que cero.',
      target_review: 'El objetivo debe ser menor que el valor de revisar. No cambié nada.',
      worry_action: 'Los minutos de preocupación deben ser menores que los de acción. No cambié nada.',
    })[code] ?? 'No pude aplicar ese valor.',
  alertsPaused: (min) => (min > 0 ? `🔕 Alertas en pausa por ${min} min.` : '🔔 Alertas reactivadas.'),
  alertsResumed: () => '🔔 Alertas reactivadas.',
  stopped: () => '🛑 Listo: ninguna acción se ejecutará sobre tus anuncios hasta que escribas REANUDAR. Las alertas siguen llegando.',
  resumed: () => '▶️ Acciones habilitadas de nuevo (siempre con tu confirmación).',
  recommendationApplied: (recs) =>
    `✅ Umbrales actualizados: ${recs.map((r) => `${THRESHOLD_LABELS[r.name]?.label ?? r.name} ${formatThresholdValue(r.name, r.recommended)}`).join(', ')}.`,
  actionsDisabled: () => 'Las acciones sobre los anuncios están desactivadas en la app (modo solo alertas). Actívalas en Anuncios > Alertas si quieres usarlas.',
  needId: (command) => `Indica el número de la solicitud, por ejemplo: ${command} 12.`,
  invalid: (command) =>
    command === 'valor'
      ? 'Formato: valor <nombre> <número>. Ejemplo: valor revisar 3000.'
      : 'Formato: pausa alertas <minutos>. Ejemplo: pausa alertas 30.',
  tokenProblem: () => '🚨 No puedo leer tu cuenta de Meta: el token de acceso venció o fue revocado. Genera uno nuevo y actualiza META_ACCESS_TOKEN para que el monitoreo siga funcionando.',
  unknown: () => 'No entendí ese mensaje. Escribe "ayuda" para ver los comandos.',
};
