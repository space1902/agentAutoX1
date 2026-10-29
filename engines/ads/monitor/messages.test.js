import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from './messages.js';
import { DEFAULT_CONFIG } from './config.js';

// Voseo forms (accented) and typical Rioplatense words. Unaccented "pausa", "responde" are valid tuteo.
const VOSEO = /(?<!\p{L})(vos|sos|tenés|querés|podés|ponés|mirá|respondé|confirmá|pausá|revisá|hacé|andá|escribí|mandá|decime|fijate|acá|dale|che|acordate|avisame)(?!\p{L})/iu;

const alertSamples = [
  { type: 'ad_no_sale', level: 'worry', severity: 1, adName: 'Video 1', adId: 'a1', spentSinceSale: 2600, thresholds: { target: 2500, review: 5000 } },
  { type: 'ad_no_sale', level: 'action', severity: 2, adName: 'Video 1', adId: 'a1', spentSinceSale: 5300, actions: [{ kind: 'pause_adset', targetId: 's1', adId: 'a1', label: 'Video 1' }] },
  { type: 'account_gap', level: 'worry', severity: 1, minutes: 50, thresholdMin: 45 },
  { type: 'account_gap', level: 'action', severity: 2, minutes: 70, thresholdMin: 60, actions: [{ kind: 'pause_adset', targetId: 's2', adId: 'a2', label: 'Dos' }] },
  { type: 'account_gap', level: 'action', severity: 2, minutes: 70, thresholdMin: 60, actions: [] },
  { type: 'ad_status', level: 'critical', severity: 2, adName: 'Video 1', status: 'DISAPPROVED' },
  { type: 'ad_status', level: 'critical', severity: 2, adName: 'Video 1', status: 'WITH_ISSUES' },
  { type: 'account_status', level: 'critical', severity: 2, status: 2, disableReason: 1 },
  { type: 'spend_cap', level: 'critical', severity: 2, spendCap: 1000000, amountSpent: 1000000 },
  { type: 'ad_no_spend', level: 'worry', severity: 1, adName: 'Video 1', hours: 2 },
  { type: 'pixel_suspect', level: 'critical', severity: 2, conversations: 25, hours: 3 },
  { type: 'cost_per_conversation', level: 'worry', severity: 1, adName: 'Video 1', current: 620, baseline: 400 },
  { type: 'frequency', level: 'worry', severity: 1, adName: 'Video 1', frequency: 2.8, limit: 2.5 },
  { type: 'ctr_drop', level: 'worry', severity: 1, adName: 'Video 1', current: 1, baseline: 2 },
  { type: 'cpm_rise', level: 'worry', severity: 1, adName: 'Video 1', current: 8000, baseline: 5000 },
];

test('formatMoney uses dot thousands separators', () => {
  assert.equal(m.formatMoney(2500), '$2.500');
  assert.equal(m.formatMoney(1234567.4), '$1.234.567');
  assert.equal(m.formatMoney(0), '$0');
});

test('every alert type produces a non-empty Spanish message mentioning the ad when relevant', () => {
  for (const alert of alertSamples) {
    const text = m.formatAlert(alert, { requestId: alert.actions?.length ? 12 : null });
    assert.ok(text.length > 20, alert.type);
    if (alert.adName) assert.ok(text.includes(alert.adName), `${alert.type} should name the ad`);
  }
});

test('action requests carry the id and how to answer, plus the expiry', () => {
  const text = m.formatAlert(alertSamples[1], { requestId: 12, ttlMin: 120 });
  assert.match(text, /SI 12/);
  assert.match(text, /NO 12/);
  assert.match(text, /2 horas|120 min/);
  assert.match(text, /\$5\.300/);
});

test('account-gap request lists suggested ads', () => {
  const text = m.formatAlert(alertSamples[3], { requestId: 9, ttlMin: 120 });
  assert.match(text, /Dos/);
  assert.match(text, /SI 9/);
});

test('summary shows colors, spend, CPA and totals', () => {
  const text = m.formatSummary(
    {
      rows: [
        { adName: 'Uno', spend: 5000, purchases: 4, cpa: 1250, color: 'green' },
        { adName: 'Dos', spend: 9000, purchases: 1, cpa: 9000, color: 'red' },
        { adName: 'Tres', spend: 3000, purchases: 0, cpa: null, color: 'yellow' },
      ],
      totals: { spend: 17000, purchases: 5, cpa: 3400, color: 'yellow' },
    },
    { hourLabel: '15:00' },
  );
  assert.match(text, /🟢/);
  assert.match(text, /🟡/);
  assert.match(text, /🔴/);
  assert.match(text, /\$17\.000/);
  assert.match(text, /15:00/);
  assert.match(text, /Uno/);
});

test('summary with no activity still says so', () => {
  const text = m.formatSummary({ rows: [], totals: { spend: 0, purchases: 0, cpa: null, color: 'none' } }, { hourLabel: '09:00' });
  assert.match(text, /sin (gasto|actividad)/i);
});

test('recommendation message shows current vs recommended and how to accept', () => {
  const text = m.formatRecommendation(
    [{ name: 'targetCpa', current: 2500, recommended: 3300, reason: 'x' }, { name: 'gapWorryMin', current: 45, recommended: 25, reason: 'y' }],
    { id: 5, days: 5 },
  );
  assert.match(text, /ACEPTAR 5/);
  assert.match(text, /\$2\.500/);
  assert.match(text, /\$3\.300/);
  assert.match(text, /valor /i);
});

test('status message summarises config, pending requests and pauses', () => {
  const text = m.formatStatus({
    config: DEFAULT_CONFIG,
    summary: { rows: [], totals: { spend: 1000, purchases: 1, cpa: 1000, color: 'green' } },
    minutesSinceSale: 12,
    pending: [{ id: 3, label: 'Pausar Video 1' }],
    alertsPausedMin: 0,
  });
  assert.match(text, /12 min/);
  assert.match(text, /#?3/);
  assert.match(text, /alert_only|solo alertas/i);
});

test('pause requests mention the ad set of the ad, by the ad name', () => {
  const one = m.formatAlert(alertSamples[1], { requestId: 1, ttlMin: 120 });
  assert.match(one, /conjunto del anuncio «Video 1»/);
  const gap = m.formatAlert(alertSamples[3], { requestId: 1, ttlMin: 120 });
  assert.match(gap, /conjunto del anuncio «Dos»/);
});

test('status message shows the Meta API access tier when known', () => {
  const base = {
    config: DEFAULT_CONFIG,
    summary: { rows: [], totals: { spend: 0, purchases: 0, cpa: null, color: 'none' } },
    minutesSinceSale: null, pending: [], alertsPausedMin: 0,
  };
  assert.match(m.formatStatus({ ...base, accessTier: 'development_access' }), /development_access/);
  assert.doesNotMatch(m.formatStatus(base), /acceso a la API/i);
});

test('errorText prefers Meta user-facing title and message', () => {
  assert.equal(m.errorText({ message: 'Invalid parameter' }), 'Invalid parameter');
  assert.equal(m.errorText({ message: 'Invalid parameter', userMessage: 'Falta el número' }), 'Falta el número');
  assert.equal(
    m.errorText({ message: 'x', userTitle: 'Se requiere un número', userMessage: 'Agrega uno' }),
    'Se requiere un número: Agrega uno',
  );
});

test('help lists the commands', () => {
  const text = m.formatHelp();
  for (const word of ['SI', 'NO', 'ACEPTAR', 'valor', 'estado', 'pausa alertas', 'DETENER', 'ayuda']) {
    assert.ok(text.includes(word), word);
  }
});

test('action outcome messages', () => {
  assert.match(m.replies.executed({ id: 3, labels: ['Video 1'] }), /Video 1/);
  assert.match(m.replies.failed({ id: 3, error: 'boom' }), /boom/);
  assert.match(m.replies.expired(3), /expir/i);
  assert.match(m.replies.notFound(99), /99/);
  assert.match(m.replies.queued({ id: 3, untilHour: 7 }), /07:00/);
  assert.match(m.replies.killSwitch(), /DETENER|detenido/i);
  assert.match(m.replies.rejected(3), /3/);
  assert.match(m.replies.thresholdSet({ name: 'reviewCpa', value: 3000 }), /\$3\.000/);
  assert.match(m.replies.alertsPaused(30), /30/);
  assert.match(m.replies.alertsResumed(), /alertas/i);
  assert.match(m.replies.unknown(), /ayuda/i);
});

test('no message uses voseo (tuteo only)', () => {
  const texts = [
    ...alertSamples.map((a) => m.formatAlert(a, { requestId: a.actions?.length ? 1 : null, ttlMin: 120 })),
    m.formatHelp(),
    m.formatRecommendation([{ name: 'targetCpa', current: 2500, recommended: 3300 }], { id: 1, days: 5 }),
    m.replies.unknown(), m.replies.killSwitch(), m.replies.expired(1), m.replies.queued({ id: 1, untilHour: 7 }),
    m.replies.executed({ id: 1, labels: ['x'] }), m.replies.failed({ id: 1, error: 'e' }),
    m.replies.needId('SI'), m.replies.notFound(1), m.replies.invalid('valor'),
  ];
  for (const t of texts) assert.doesNotMatch(t, VOSEO, t);
});
