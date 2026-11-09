// Allowlisted analysis views over ads.db. They are the ONLY relations the "Analista" agent may query (see
// engines/agent/sql-guard.js). Helper tables `ad_ct`, `country_rates` and `spend_vat` exist so the views can be pure SQL:
// the CT tag is derived in JS (extractCt) and is only informational: rows are keyed by the real Meta campaign (campaign_id) and the exchange rates live in the JSON config.
import { extractCt } from './parse.js';

export const VIEWS_VERSION = 10;

// Views of earlier versions that no longer exist (dropped on upgrade).
const LEGACY_VIEWS = ['v_ct_daily'];
export const NO_COUNTRY_LABEL = 'Sin país';

export const HELPER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ad_ct (ad_id TEXT PRIMARY KEY, ct TEXT NOT NULL);
-- Campaign that owns each ad: Meta's ad list first, else the latest insight row (ads that left the list keep their history).
CREATE VIEW IF NOT EXISTS ad_campaign AS
  SELECT a.ad_id AS ad_id, a.campaign_id AS campaign_id, a.campaign_name AS campaign_name FROM ads a
  UNION ALL
  SELECT i.ad_id, i.campaign_id, i.campaign_name FROM insights i
    JOIN (SELECT ad_id, MAX(date) AS date FROM insights GROUP BY ad_id) m ON i.ad_id = m.ad_id AND i.date = m.date
    WHERE i.ad_id NOT IN (SELECT ad_id FROM ads) GROUP BY i.ad_id;
-- Accounts whose spend is not in the base currency: v_ads_daily leaves them out (the app converts them, SQL does not).
CREATE TABLE IF NOT EXISTS excluded_accounts (account_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS spend_vat (id INTEGER PRIMARY KEY CHECK (id = 1), pct REAL NOT NULL);
INSERT OR IGNORE INTO spend_vat (id, pct) VALUES (1, 19);
CREATE TABLE IF NOT EXISTS country_rates (
  country TEXT PRIMARY KEY, currency TEXT NOT NULL, rate_to_cop REAL NOT NULL, fee_pct REAL NOT NULL, cost_per_sale REAL NOT NULL, tax_pct REAL NOT NULL
);
`;

// Multiplier that turns the spend Meta reports into the spend actually charged (IVA included).
const VAT_PCT = 'COALESCE((SELECT pct FROM spend_vat WHERE id = 1), 0)';
const VAT_FACTOR = `(1 + ${VAT_PCT} / 100.0)`;
const COUNTRY = (expr) => `COALESCE(NULLIF(${expr}, ''), '${NO_COUNTRY_LABEL}')`;

// name -> { sql (SELECT body), description, columns: [[name, description]] }
export const VIEWS = {
  v_ads_daily: {
    description: 'Gasto y resultados de Meta por día, país, campaña y anuncio (una fila por día+anuncio+país de entrega). El gasto (spend) ya incluye el IVA que cobra Meta: úsalo tal cual para costo por venta y ganancia; no le sumes IVA otra vez. El ROAS se calcula con el gasto sin IVA (spend_net).',
    sql: `SELECT i.date AS date, ${COUNTRY('i.country')} AS country, COALESCE(c.ct, 'Sin CT') AS ct, i.campaign_id AS campaign_id, i.campaign_name AS campaign,
      i.ad_id AS ad_id, i.ad_name AS ad_name, i.gasto * ${VAT_FACTOR} AS spend, i.gasto AS spend_net, i.gasto * ${VAT_PCT} / 100.0 AS vat, i.mensajes AS messages, i.impressions AS impressions, i.clicks AS clicks
      FROM insights i LEFT JOIN ad_ct c ON c.ad_id = i.ad_id
      WHERE i.account_id NOT IN (SELECT account_id FROM excluded_accounts)`,
    columns: [
      ['date', 'Día (AAAA-MM-DD, zona horaria de la cuenta).'],
      ['country', 'País donde Meta entregó el anuncio (CO, MX, VE...) o «Sin país».'],
      ['ct', 'Etiqueta «CT 07» leída del nombre (solo informativa: varias campañas pueden compartirla), o «Sin CT».'],
      ['campaign_id', 'ID de la campaña en Meta. Agrupa por este campo, no por ct.'],
      ['campaign', 'Nombre completo de la campaña.'],
      ['ad_id', 'ID del anuncio en Meta.'],
      ['ad_name', 'Nombre del anuncio.'],
      ['spend', 'Gasto en COP CON IVA (lo que realmente cobra Meta). Úsalo para costo por venta y ganancia (el ROAS usa spend_net).'],
      ['spend_net', 'Gasto en COP SIN IVA, como lo reporta la API de Meta. Es el divisor del ROAS (ingresos / spend_net); no lo mezcles con spend en otras cuentas.'],
      ['vat', 'IVA sobre el gasto en COP (spend - spend_net). Ya está incluido en spend: no lo sumes otra vez.'],
      ['messages', 'Conversaciones de mensajes iniciadas.'],
      ['impressions', 'Impresiones.'],
      ['clicks', 'Clics.'],
    ],
  },
  v_sales: {
    description: 'Pagos válidos (comprobantes) con su país y la campaña dueña del anuncio. Incluye el nombre del cliente. Incluye los de resultado «Pago válido» y los que el usuario aceptó a mano en la app (accepted_manually = 1); una fila = una venta. No incluye los pagos que ya no están en la hoja ni los que el usuario descartó en la app.',
    sql: `SELECT c.date AS date, ${COUNTRY('COALESCE(o.country, c.country)')} AS country, COALESCE(t.ct, 'Sin CT') AS ct,
      COALESCE(ac.campaign_id, '') AS campaign_id, CASE WHEN COALESCE(m.ad_id, c.ad_id) = '' THEN 'Sin anuncio' ELSE COALESCE(ac.campaign_name, 'Anuncio desconocido') END AS campaign, COALESCE(m.ad_id, c.ad_id) AS ad_id,
      COALESCE(vo.valor, c.valor) AS value, COALESCE(vo.valor, c.valor) * COALESCE(r.rate_to_cop, 1) AS value_cop, c.flow AS flow, c.result AS result, c.bank AS bank, c.client_name AS client_name,
      CASE WHEN a.key IS NOT NULL AND c.result NOT LIKE 'pago v_lido' THEN 1 ELSE 0 END AS accepted_manually
      FROM comprobantes c LEFT JOIN comprobante_overrides o ON o.key = c.key LEFT JOIN comprobante_accepts a ON a.key = c.key
      LEFT JOIN comprobante_ad_overrides m ON m.key = c.key LEFT JOIN comprobante_value_overrides vo ON vo.key = c.key LEFT JOIN ad_ct t ON t.ad_id = COALESCE(m.ad_id, c.ad_id)
      LEFT JOIN ad_campaign ac ON ac.ad_id = COALESCE(m.ad_id, c.ad_id)
      LEFT JOIN country_rates r ON r.country = COALESCE(o.country, c.country)
      WHERE (c.result LIKE 'pago v_lido' OR a.key IS NOT NULL) AND c.missing_since IS NULL
        AND NOT EXISTS (SELECT 1 FROM comprobante_rejects j WHERE j.key = c.key)`,
    columns: [
      ['date', 'Día del pago.'],
      ['country', 'País del cliente (por teléfono, campaña o flujo) o «Sin país».'],
      ['ct', 'Etiqueta CT del nombre de la campaña (informativa), o «Sin CT».'],
      ['campaign_id', 'ID de la campaña dueña del anuncio que originó la venta (vacío si no se pudo asignar).'],
      ['campaign', 'Nombre de esa campaña, «Sin anuncio» si el pago no trae anuncio o «Anuncio desconocido».'],
      ['ad_id', 'ID del anuncio (vacío si no se pudo asignar).'],
      ['value', 'Valor (corregido a mano si el usuario lo editó en la app) en la moneda local del país (MXN en México, USD en Venezuela, COP en Colombia).'],
      ['value_cop', 'Valor convertido a COP con la tasa configurada (usa esta para sumar entre países).'],
      ['flow', 'Flujo de venta del chat.'],
      ['result', 'Resultado del comprobante en la hoja: «Pago válido» o, si se aceptó a mano, el que tenía (por ejemplo «Nombre a revisar»).'],
      ['bank', 'Banco o método de pago.'],
      ['client_name', 'Nombre del cliente en el chat de WhatsApp/Leona (vacío si la hoja no lo trae). No es el titular de la cuenta bancaria.'],
      ['accepted_manually', '1 si el pago no estaba como válido en la hoja y el usuario lo aceptó a mano en la app; 0 si no.'],
    ],
  },
  v_ads: {
    description: 'Un anuncio por fila con su estado, su primer día de gasto y el presupuesto vigente.',
    sql: `SELECT a.ad_id AS ad_id, COALESCE(t.ct, 'Sin CT') AS ct, a.campaign_id AS campaign_id, a.campaign_name AS campaign, a.name AS ad_name, a.effective_status AS status,
      a.first_spend_date AS first_spend_date,
      CASE WHEN a.first_spend_date IS NULL THEN NULL
        ELSE CAST(julianday((SELECT MAX(date) FROM insights)) - julianday(a.first_spend_date) AS INTEGER) + 1 END AS day_n,
      COALESCE(
        (SELECT daily_budget FROM budget_history b WHERE b.entity_type = 'adset' AND b.entity_id = a.adset_id AND b.daily_budget IS NOT NULL ORDER BY b.id DESC LIMIT 1),
        (SELECT daily_budget FROM budget_history b WHERE b.entity_type = 'campaign' AND b.entity_id = a.campaign_id AND b.daily_budget IS NOT NULL ORDER BY b.id DESC LIMIT 1)
      ) AS current_budget
      FROM ads a LEFT JOIN ad_ct t ON t.ad_id = a.ad_id`,
    columns: [
      ['ad_id', 'ID del anuncio en Meta.'],
      ['ct', 'Etiqueta CT del nombre (informativa) o «Sin CT».'],
      ['campaign_id', 'ID de la campaña en Meta.'],
      ['campaign', 'Nombre de la campaña.'],
      ['ad_name', 'Nombre del anuncio.'],
      ['status', 'Estado efectivo en Meta (ACTIVE, PAUSED...).'],
      ['first_spend_date', 'Primer día con gasto = «día 1» del anuncio.'],
      ['day_n', 'Día N del anuncio al último día sincronizado (día 1 = primer gasto).'],
      ['current_budget', 'Presupuesto diario vigente (conjunto de anuncios o campaña), en COP.'],
    ],
  },
  v_budget_events: {
    description: 'Cambios de presupuesto detectados en el registro de actividad de Meta.',
    sql: `SELECT e.entity_type AS entity_type, e.entity_id AS entity_id,
      COALESCE((SELECT MAX(CASE WHEN e.entity_type = 'campaign' THEN a.campaign_name ELSE a.adset_name END) FROM ads a
        WHERE (e.entity_type = 'campaign' AND a.campaign_id = e.entity_id) OR (e.entity_type = 'adset' AND a.adset_id = e.entity_id)), e.entity_id) AS entity_name,
      e.date AS date, e.old_budget AS old_budget, e.new_budget AS new_budget,
      CASE WHEN e.old_budget > 0 THEN ROUND((e.new_budget - e.old_budget) * 100.0 / e.old_budget, 1) ELSE NULL END AS pct
      FROM budget_events e`,
    columns: [
      ['entity_type', '«adset» (conjunto de anuncios) o «campaign» (campaña).'],
      ['entity_id', 'ID de la entidad.'],
      ['entity_name', 'Nombre de la entidad.'],
      ['date', 'Día del cambio.'],
      ['old_budget', 'Presupuesto diario anterior (COP).'],
      ['new_budget', 'Presupuesto diario nuevo (COP).'],
      ['pct', 'Variación en % (positivo = subida).'],
    ],
  },
  v_decisions: {
    description: 'Decisiones automáticas ya emitidas por la app (veredicto de prueba día 4, revisión tras subir presupuesto).',
    sql: `SELECT d.id AS id, d.kind AS kind, d.entity_type AS entity_type, d.entity_id AS entity_id, d.label AS label, d.day_n AS day_n,
      d.due_date AS due_date, d.status AS status, json_extract(d.payload, '$.verdict.label') AS verdict, json_extract(d.payload, '$.reason') AS reason,
      date(d.created_at / 1000, 'unixepoch') AS created
      FROM decisions d`,
    columns: [
      ['id', 'Número de la decisión.'],
      ['kind', '«test» (anuncio), «campaign_test» (campaña; «ct_test» en decisiones antiguas por CT) o «budget» (tras subir presupuesto).'],
      ['entity_type', 'ad, campaign, adset (o ct en decisiones antiguas).'],
      ['entity_id', 'ID de la entidad (código CT en decisiones antiguas por CT).'],
      ['label', 'Nombre legible.'],
      ['day_n', 'Día en que se evaluó.'],
      ['due_date', 'Día en que correspondía la decisión.'],
      ['status', 'pending, done o ignored (lo que hizo el usuario con ella).'],
      ['verdict', 'Veredicto de la app (Escalar, Mantener, Apagar, Subir más, Bajar presupuesto...).'],
      ['reason', 'Motivo en texto.'],
      ['created', 'Día en que se emitió.'],
    ],
  },
  v_campaign_daily: {
    description: 'Gasto (con IVA) y ventas por día, país y campaña de Meta en una sola tabla (para tendencias). Una fila por campaña real: dos campañas con el mismo CT en el nombre son filas distintas. Para el ROAS de un periodo suma primero y divide después.',
    sql: `SELECT date, country, campaign_id, campaign, spend, spend_net, vat, messages, sales, revenue_cop,
      CASE WHEN spend_net > 0 THEN revenue_cop / spend_net ELSE NULL END AS roas,
      CASE WHEN sales > 0 THEN spend / sales ELSE NULL END AS cost_per_sale
      FROM (
        SELECT date, country, campaign_id, MAX(campaign) AS campaign, SUM(spend) AS spend, SUM(spend_net) AS spend_net, SUM(vat) AS vat, SUM(messages) AS messages, SUM(sales) AS sales, SUM(revenue_cop) AS revenue_cop FROM (
          SELECT date, country, campaign_id, campaign, spend, spend_net, vat, messages, 0 AS sales, 0.0 AS revenue_cop FROM v_ads_daily
          UNION ALL SELECT date, country, campaign_id, campaign, 0.0, 0.0, 0.0, 0, 1, value_cop FROM v_sales
        ) GROUP BY date, country, campaign_id
      )`,
    columns: [
      ['date', 'Día.'],
      ['country', 'País (el del gasto viene de Meta; el de la venta, del cliente).'],
      ['campaign_id', 'ID de la campaña en Meta (vacío = ventas sin anuncio).'],
      ['campaign', 'Nombre completo de la campaña («Sin anuncio» para pagos sin anuncio).'],
      ['spend', 'Gasto en COP CON IVA (el real). Úsalo para costo por venta (el ROAS usa spend_net).'],
      ['spend_net', 'Gasto en COP sin IVA: divisor del ROAS (no lo mezcles con spend en otras cuentas).'],
      ['vat', 'IVA del gasto (ya incluido en spend; no lo sumes otra vez).'],
      ['messages', 'Conversaciones iniciadas.'],
      ['sales', 'Número de ventas válidas.'],
      ['revenue_cop', 'Ingresos en COP.'],
      ['roas', 'revenue_cop / spend_net de esa fila: valor entre gasto SIN IVA (NULL sin gasto).'],
      ['cost_per_sale', 'spend / sales de esa fila (NULL sin ventas).'],
    ],
  },
};

export const VIEW_NAMES = Object.freeze(Object.keys(VIEWS));

const exists = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'view'").get(name) !== undefined;

// Idempotent: recreates the views only when the stored version differs (or one is missing).
export function installViews(db) {
  db.exec(HELPER_SCHEMA);
  const current = db.prepare("SELECT value FROM kv WHERE key = 'views_version'").get();
  if (current && Number(JSON.parse(current.value)) === VIEWS_VERSION && VIEW_NAMES.every((n) => exists(db, n))) return false;
  db.exec('BEGIN');
  try {
    for (const name of [...VIEW_NAMES, ...LEGACY_VIEWS].reverse()) db.exec(`DROP VIEW IF EXISTS ${name}`);
    for (const name of VIEW_NAMES) db.exec(`CREATE VIEW ${name} AS ${VIEWS[name].sql}`);
    db.prepare("INSERT INTO kv (key, value) VALUES ('views_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(VIEWS_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

// ad_id -> CT code, derived from the latest known campaign / ad names.
export function refreshAdCt(db) {
  const rows = db.prepare(`SELECT i.ad_id, i.ad_name, i.campaign_name FROM insights i
    JOIN (SELECT ad_id, MAX(date) AS date FROM insights GROUP BY ad_id) m ON i.ad_id = m.ad_id AND i.date = m.date`).all();
  const upsert = db.prepare('INSERT INTO ad_ct (ad_id, ct) VALUES (?, ?) ON CONFLICT(ad_id) DO UPDATE SET ct = excluded.ct');
  const drop = db.prepare('DELETE FROM ad_ct WHERE ad_id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const ct = extractCt(r.campaign_name, r.ad_name);
      if (ct) upsert.run(r.ad_id, ct);
      else drop.run(r.ad_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Mirrors the spend IVA % into ads.db so the views can add it to the spend.
export function syncExcludedAccounts(db, ids) {
  const wanted = [...new Set(ids ?? [])].sort();
  const current = db.prepare('SELECT account_id FROM excluded_accounts ORDER BY account_id').all().map((r) => r.account_id);
  if (JSON.stringify(wanted) === JSON.stringify(current)) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM excluded_accounts');
    const put = db.prepare('INSERT INTO excluded_accounts (account_id) VALUES (?)');
    for (const id of wanted) put.run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

export function syncSpendVat(db, pct) {
  const wanted = Math.max(0, Number(pct) || 0);
  const current = db.prepare('SELECT pct FROM spend_vat WHERE id = 1').get();
  if (current && current.pct === wanted) return false;
  db.prepare('INSERT INTO spend_vat (id, pct) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET pct = excluded.pct').run(wanted);
  return true;
}

// Mirrors the config's per-country economics into ads.db so SQL can convert to COP.
export function syncCountryRates(db, countries) {
  const wanted = Object.entries(countries ?? {})
    .map(([code, c]) => [code, c.currency ?? 'COP', c.rateToCop > 0 ? c.rateToCop : 1, c.feePct ?? 0, c.costPerSale ?? 0, c.taxPct ?? 0])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const current = db
    .prepare('SELECT country, currency, rate_to_cop, fee_pct, cost_per_sale, tax_pct FROM country_rates ORDER BY country')
    .all()
    .map((r) => [r.country, r.currency, r.rate_to_cop, r.fee_pct, r.cost_per_sale, r.tax_pct]);
  if (JSON.stringify(current) === JSON.stringify(wanted)) return false;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM country_rates');
    const insert = db.prepare('INSERT INTO country_rates (country, currency, rate_to_cop, fee_pct, cost_per_sale, tax_pct) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of wanted) insert.run(...row);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}
