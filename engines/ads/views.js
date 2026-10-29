// Allowlisted analysis views over ads.db. They are the ONLY relations the "Analista" agent may query (see
// engines/agent/sql-guard.js). Helper tables `ad_ct` and `country_rates` exist so the views can be pure SQL:
// the CT code is derived in JS (extractCt) and the exchange rates live in the JSON config.
import { extractCt } from './parse.js';

export const VIEWS_VERSION = 2;
export const NO_COUNTRY_LABEL = 'Sin país';

export const HELPER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ad_ct (ad_id TEXT PRIMARY KEY, ct TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS country_rates (
  country TEXT PRIMARY KEY, currency TEXT NOT NULL, rate_to_cop REAL NOT NULL, fee_pct REAL NOT NULL, cost_per_sale REAL NOT NULL, tax_pct REAL NOT NULL
);
`;

const COUNTRY = (expr) => `COALESCE(NULLIF(${expr}, ''), '${NO_COUNTRY_LABEL}')`;

// name -> { sql (SELECT body), description, columns: [[name, description]] }
export const VIEWS = {
  v_ads_daily: {
    description: 'Gasto y resultados de Meta por día, país, CT y anuncio (una fila por día+anuncio+país de entrega).',
    sql: `SELECT i.date AS date, ${COUNTRY('i.country')} AS country, COALESCE(c.ct, 'Sin CT') AS ct, i.campaign_name AS campaign,
      i.ad_id AS ad_id, i.ad_name AS ad_name, i.gasto AS spend, i.mensajes AS messages, i.impressions AS impressions, i.clicks AS clicks
      FROM insights i LEFT JOIN ad_ct c ON c.ad_id = i.ad_id`,
    columns: [
      ['date', 'Día (AAAA-MM-DD, zona horaria de la cuenta).'],
      ['country', 'País donde Meta entregó el anuncio (CO, MX, VE...) o «Sin país».'],
      ['ct', 'Código de la prueba creativa, p. ej. «CT 07», o «Sin CT».'],
      ['campaign', 'Nombre de la campaña.'],
      ['ad_id', 'ID del anuncio en Meta.'],
      ['ad_name', 'Nombre del anuncio.'],
      ['spend', 'Gasto en COP (moneda de la cuenta).'],
      ['messages', 'Conversaciones de mensajes iniciadas.'],
      ['impressions', 'Impresiones.'],
      ['clicks', 'Clics.'],
    ],
  },
  v_sales: {
    description: 'Pagos válidos (comprobantes) con su país y CT. Solo incluye resultado «Pago válido»; una fila = una venta.',
    sql: `SELECT c.date AS date, ${COUNTRY('COALESCE(o.country, c.country)')} AS country, COALESCE(t.ct, 'Sin CT') AS ct, c.ad_id AS ad_id,
      c.valor AS value, c.valor * COALESCE(r.rate_to_cop, 1) AS value_cop, c.flow AS flow, c.result AS result, c.bank AS bank
      FROM comprobantes c LEFT JOIN comprobante_overrides o ON o.key = c.key LEFT JOIN ad_ct t ON t.ad_id = c.ad_id
      LEFT JOIN country_rates r ON r.country = COALESCE(o.country, c.country)
      WHERE c.result LIKE 'pago v_lido'`,
    columns: [
      ['date', 'Día del pago.'],
      ['country', 'País del cliente (por teléfono, campaña o flujo) o «Sin país».'],
      ['ct', 'CT del anuncio que originó la venta, o «Sin CT» si no se pudo asignar.'],
      ['ad_id', 'ID del anuncio (vacío si no se pudo asignar).'],
      ['value', 'Valor en la moneda local del país (MXN en México, USD en Venezuela, COP en Colombia).'],
      ['value_cop', 'Valor convertido a COP con la tasa configurada (usa esta para sumar entre países).'],
      ['flow', 'Flujo de venta del chat.'],
      ['result', 'Resultado del comprobante (siempre pago válido en esta vista).'],
      ['bank', 'Banco o método de pago.'],
    ],
  },
  v_ads: {
    description: 'Un anuncio por fila con su estado, su primer día de gasto y el presupuesto vigente.',
    sql: `SELECT a.ad_id AS ad_id, COALESCE(t.ct, 'Sin CT') AS ct, a.campaign_name AS campaign, a.name AS ad_name, a.effective_status AS status,
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
      ['ct', 'Código CT o «Sin CT».'],
      ['campaign', 'Campaña.'],
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
      ['kind', '«test» (anuncio), «ct_test» (CT) o «budget» (tras subir presupuesto).'],
      ['entity_type', 'ad, ct, adset o campaign.'],
      ['entity_id', 'ID o código de la entidad.'],
      ['label', 'Nombre legible.'],
      ['day_n', 'Día en que se evaluó.'],
      ['due_date', 'Día en que correspondía la decisión.'],
      ['status', 'pending, done o ignored (lo que hizo el usuario con ella).'],
      ['verdict', 'Veredicto de la app (Escalar, Mantener, Apagar, Subir más, Bajar presupuesto...).'],
      ['reason', 'Motivo en texto.'],
      ['created', 'Día en que se emitió.'],
    ],
  },
  v_ct_daily: {
    description: 'Gasto y ventas por día, país y CT en una sola tabla (para tendencias). Para el ROAS de un periodo suma primero y divide después.',
    sql: `SELECT date, country, ct, spend, messages, sales, revenue_cop,
      CASE WHEN spend > 0 THEN revenue_cop / spend ELSE NULL END AS roas,
      CASE WHEN sales > 0 THEN spend / sales ELSE NULL END AS cost_per_sale
      FROM (
        SELECT date, country, ct, SUM(spend) AS spend, SUM(messages) AS messages, SUM(sales) AS sales, SUM(revenue_cop) AS revenue_cop FROM (
          SELECT date, country, ct, spend, messages, 0 AS sales, 0.0 AS revenue_cop FROM v_ads_daily
          UNION ALL SELECT date, country, ct, 0.0, 0, 1, value_cop FROM v_sales
        ) GROUP BY date, country, ct
      )`,
    columns: [
      ['date', 'Día.'],
      ['country', 'País (el del gasto viene de Meta; el de la venta, del cliente).'],
      ['ct', 'Código CT.'],
      ['spend', 'Gasto en COP.'],
      ['messages', 'Conversaciones iniciadas.'],
      ['sales', 'Número de ventas válidas.'],
      ['revenue_cop', 'Ingresos en COP.'],
      ['roas', 'revenue_cop / spend de esa fila (NULL sin gasto).'],
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
    for (const name of [...VIEW_NAMES].reverse()) db.exec(`DROP VIEW IF EXISTS ${name}`);
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
