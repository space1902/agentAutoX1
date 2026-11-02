import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSql } from './sql-guard.js';

const KNOWN = ['kv', 'insights', 'ads', 'budget_history', 'comprobantes', 'comprobante_overrides', 'budget_events', 'decisions', 'wa_outbox', 'ad_ct', 'country_rates', 'v_ads_daily', 'v_sales', 'v_ads', 'v_budget_events', 'v_decisions', 'v_campaign_daily'];
const ok = (sql) => assert.equal(validateSql(sql, { knownTables: KNOWN }).ok, true, `${sql} -> ${JSON.stringify(validateSql(sql, { knownTables: KNOWN }))}`);
const bad = (sql, layer) => {
  const res = validateSql(sql, { knownTables: KNOWN });
  assert.equal(res.ok, false, `should reject: ${sql}`);
  if (layer) assert.equal(res.layer, layer, `${sql} -> ${res.reason}`);
};

test('accepts plain analytical queries over the views', () => {
  ok('SELECT ct, SUM(spend) AS spend FROM v_ads_daily WHERE date >= "2026-10-01" GROUP BY ct ORDER BY spend DESC LIMIT 10');
  ok("select date, round(revenue_cop / spend, 2) as roas from v_campaign_daily where campaign_id = 'c1' and spend > 0;");
  ok('SELECT a.ct, COUNT(*) FROM v_ads a JOIN v_sales s ON s.ad_id = a.ad_id GROUP BY a.ct');
  ok('SELECT x.ct FROM v_ads x, v_sales y WHERE x.ad_id = y.ad_id');
  ok('WITH t AS (SELECT ct, SUM(spend) s FROM v_ads_daily GROUP BY ct) SELECT * FROM t WHERE s > 0');
  ok('WITH a(ct, s) AS (SELECT ct, spend FROM v_ads_daily), b AS (SELECT ct FROM a) SELECT * FROM b');
  ok('SELECT campaign, row_number() OVER (PARTITION BY country ORDER BY spend DESC) AS n FROM v_campaign_daily');
  ok('SELECT CASE WHEN spend > 0 THEN 1 ELSE 0 END, CAST(spend AS INTEGER), strftime("%Y-%m", date) FROM v_ads_daily WHERE ct IN ("CT 01", "CT 02")');
  ok('SELECT (SELECT MAX(date) FROM v_ads_daily) AS last_day, replace(ct, " ", "") FROM v_ads');
  ok("SELECT 'DROP TABLE x; -- hi' AS text FROM v_ads");
});

test('rejects anything that is not a single read-only statement', () => {
  bad('', 'forma');
  bad('SELECT 1; SELECT 2', 'una-sentencia');
  bad('DELETE FROM v_ads', 'solo-lectura');
  bad('INSERT INTO v_ads VALUES (1)', 'solo-lectura');
  bad('PRAGMA table_info(ads)', 'solo-lectura');
  bad('WITH t AS (SELECT 1) DELETE FROM kv', 'solo-lectura');
  bad('WITH t AS (SELECT 1) INSERT OR REPLACE INTO kv VALUES (1,2)', 'solo-lectura');
  bad('WITH t AS (SELECT 1) REPLACE INTO kv VALUES (1,2)', 'solo-lectura');
  bad('ATTACH DATABASE "x.db" AS x', 'solo-lectura');
  bad('SELECT 1 -- comment', 'comentarios');
  bad('SELECT /* x */ 1', 'comentarios');
  bad('SELECT * FROM v_ads WHERE ad_id = ?', 'parametros');
  bad("SELECT 'abc FROM v_ads", 'forma');
  bad('SELECT ) UNION SELECT * FROM kv --', 'comentarios');
  bad('SELECT 1) UNION ALL SELECT value FROM kv WHERE (1', 'parentesis');
  bad(`SELECT ${'x'.repeat(5000)}`, 'forma');
});

test('rejects relations outside the allowlist, however they are written', () => {
  bad('SELECT * FROM insights', 'relaciones');
  bad('SELECT * FROM comprobantes', 'relaciones');
  bad('SELECT * FROM "insights"', 'relaciones');
  bad('SELECT * FROM [insights]', 'relaciones');
  bad('SELECT * FROM main.insights', 'relaciones');
  bad('SELECT * FROM v_ads, kv', 'relaciones');
  bad('SELECT * FROM v_ads JOIN decisions d ON 1', 'relaciones');
  bad('SELECT * FROM v_ads a LEFT JOIN (SELECT * FROM ads) b ON 1', 'relaciones');
  bad('SELECT (SELECT value FROM kv) FROM v_ads', 'relaciones');
  bad('SELECT * FROM sqlite_master', 'relaciones');
  bad('SELECT * FROM pragma_table_info("ads")', 'relaciones');
  bad('SELECT * FROM json_each("[1]")', 'relaciones');
  bad('SELECT * FROM v_ads WHERE ad_id IN (SELECT ad_id FROM comprobantes)', 'relaciones');
  bad('SELECT * FROM (kv)', 'relaciones');
  bad('SELECT 1 FROM', 'relaciones');
});

test('rejects internal table names used in any position', () => {
  bad('SELECT kv FROM v_ads', 'internas');
  bad('SELECT 1 FROM v_ads WHERE 1 = (SELECT 1 FROM v_sales WHERE sqlite_version() = "x")', 'internas');
  bad('SELECT sqlite_master.name FROM v_ads', 'internas');
});

test('only allowlisted functions run', () => {
  bad('SELECT load_extension("x")', 'solo-lectura');
  bad('SELECT readfile("C:/secret")', 'funciones');
  bad('SELECT randomblob(1000000000)', 'funciones');
  bad('SELECT json_extract(payload, "$") FROM v_ads', 'funciones');
  bad('SELECT sqlite_compileoption_used("x")', 'internas');
  bad('SELECT v_ads.zeroblob(5) FROM v_ads', 'funciones');
  ok('SELECT coalesce(spend, 0) + abs(-1) + length(ct) FROM v_ads_daily');
});

test('returns the normalized statement without the trailing semicolon', () => {
  assert.equal(validateSql('  SELECT 1 ;; ').sql, 'SELECT 1');
});
