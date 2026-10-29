// Ported from the Apps Script (trkMetrics) and the Looker action rules. Pure.

const div = (a, b) => (b ? a / b : 0);

export function computeMetrics({ gasto = 0, valor = 0, ventas = 0, mensajes = 0 }) {
  return {
    resultado: valor - gasto,
    roas: div(valor, gasto),
    costoMensaje: div(gasto, mensajes),
    ticket: div(valor, ventas),
    conversion: div(ventas, mensajes),
    costoVenta: div(gasto, ventas),
  };
}

export const ACTIONS = Object.freeze({
  wait: { key: 'wait', label: 'Esperar', tone: 'gray' },
  duplicate: { key: 'duplicate', label: 'Escalar y duplicar', tone: 'green' },
  scale: { key: 'scale', label: 'Escalar', tone: 'green' },
  keep: { key: 'keep', label: 'Mantener', tone: 'gray' },
  watch: { key: 'watch', label: 'Vigilar', tone: 'amber' },
  off: { key: 'off', label: 'Apagar', tone: 'red' },
});

export function suggestAction({ gasto, roas, ventas }, t) {
  if (gasto < t.minSpend) return ACTIONS.wait;
  if (roas >= t.duplicateRoas && ventas >= t.duplicateSales) return ACTIONS.duplicate;
  if (roas >= t.scaleRoas) return ACTIONS.scale;
  if (roas >= t.keepRoas) return ACTIONS.keep;
  if (roas >= t.watchRoas) return ACTIONS.watch;
  return ACTIONS.off;
}
