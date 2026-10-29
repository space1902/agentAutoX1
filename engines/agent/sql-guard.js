// Layered guardrails for the free-form SQL the Analista may run (adapted from Leasify's consulta-libre).
// Pure: no database access here. The layers, in order:
//   1 shape (string, size)        2 no comments / no parameters      3 single statement
//   4 SELECT or WITH only         5 no write / admin words           6 balanced parentheses
//   7 relations only from the view allowlist (or CTE names)          8 no internal tables by name
//   9 function allowlist
// The executor adds two more independent layers: a read-only connection and a hard timeout.
import { VIEW_NAMES } from '../ads/views.js';

export const MAX_SQL_LENGTH = 4000;

export const ALLOWED_FUNCTIONS = Object.freeze(new Set([
  'abs', 'avg', 'cast', 'coalesce', 'count', 'cume_dist', 'date', 'datetime', 'dense_rank', 'first_value', 'format', 'group_concat', 'ifnull', 'iif',
  'instr', 'julianday', 'lag', 'last_value', 'lead', 'length', 'lower', 'ltrim', 'max', 'min', 'nth_value', 'ntile', 'nullif', 'percent_rank', 'printf',
  'rank', 'replace', 'round', 'row_number', 'rtrim', 'sign', 'strftime', 'substr', 'substring', 'sum', 'time', 'total', 'trim', 'typeof', 'unixepoch', 'upper',
]));

// Words that may sit right before "(" without being a function call.
const BEFORE_PAREN = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'exists', 'as', 'on', 'join', 'using', 'union', 'all', 'intersect', 'except', 'having', 'by',
  'then', 'else', 'when', 'case', 'end', 'over', 'partition', 'values', 'between', 'like', 'is', 'distinct', 'limit', 'offset', 'with', 'materialized',
  'recursive', 'filter', 'rows', 'range', 'groups', 'order', 'group', 'cross', 'inner', 'left', 'outer', 'natural', 'escape', 'collate', 'glob', 'regexp',
  'match', 'asc', 'desc', 'window', 'exclude', 'preceding', 'following', 'unbounded', 'current', 'row',
]);

const WRITE_WORDS = new Set([
  'insert', 'update', 'delete', 'drop', 'create', 'alter', 'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'analyze', 'begin', 'commit', 'rollback',
  'savepoint', 'release', 'truncate', 'upsert', 'explain', 'load_extension',
]);

const FROM_END = new Set(['where', 'group', 'order', 'having', 'limit', 'union', 'intersect', 'except', 'window', 'offset']);

const fail = (layer, reason) => ({ ok: false, layer, reason });

// Replaces the content of '...' literals with spaces so keywords inside text are never inspected.
function maskStrings(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] !== "'") {
      out += sql[i++];
      continue;
    }
    let j = i + 1;
    for (;;) {
      if (j >= sql.length) return null;
      if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
      else if (sql[j] === "'") break;
      else j++;
    }
    out += `'${' '.repeat(j - i - 1)}'`;
    i = j + 1;
  }
  return out;
}

const TOKEN = /"([^"]*)"|\[([^\]]*)\]|`([^`]*)`|([A-Za-z_][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)|('[ ]*')|(\S)/g;

function tokenize(masked) {
  const tokens = [];
  for (const m of masked.matchAll(TOKEN)) {
    if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) tokens.push({ type: 'ident', value: m[1] ?? m[2] ?? m[3], quoted: true });
    else if (m[4] !== undefined) tokens.push({ type: 'ident', value: m[4], lower: m[4].toLowerCase(), quoted: false });
    else if (m[5] !== undefined) tokens.push({ type: 'num', value: m[5] });
    else if (m[6] !== undefined) tokens.push({ type: 'str', value: m[6] });
    else tokens.push({ type: 'sym', value: m[7] });
  }
  return tokens;
}

const lowerOf = (t) => (t.lower ?? String(t.value).toLowerCase());

// Names declared by WITH ... name [(cols)] AS (
function cteNames(masked) {
  const names = new Set();
  const re = /(?:\bwith\b(?:\s+recursive)?|,)\s*(?:"([^"]+)"|(\w+))\s*(?:\([^)]*\))?\s+as\s*(?:not\s+materialized\s*|materialized\s*)?\(/gi;
  for (const m of masked.matchAll(re)) names.add((m[1] ?? m[2]).toLowerCase());
  return names;
}

/**
 * @param {string} sql
 * @param {{ relations?: readonly string[], knownTables?: readonly string[] }} [options]
 *   relations: allowed views; knownTables: every table/view that really exists (so internal ones are named in the refusal).
 * @returns {{ ok: true, sql: string } | { ok: false, layer: string, reason: string }}
 */
export function validateSql(sql, { relations = VIEW_NAMES, knownTables = [] } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) return fail('forma', 'La consulta está vacía.');
  if (sql.length > MAX_SQL_LENGTH) return fail('forma', `La consulta es demasiado larga (máximo ${MAX_SQL_LENGTH} caracteres).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sql)) return fail('forma', 'La consulta tiene caracteres de control.');

  const masked = maskStrings(sql);
  if (masked === null) return fail('forma', 'Hay un texto entre comillas simples sin cerrar.');

  if (masked.includes('--') || masked.includes('/*') || masked.includes('*/')) return fail('comentarios', 'No se permiten comentarios SQL.');
  if (/[?@]|:[A-Za-z_]/.test(masked)) return fail('parametros', 'No se permiten parámetros (?, @, :). Escribe los valores dentro de la consulta.');

  const body = masked.trim().replace(/;+\s*$/, '');
  if (body.includes(';')) return fail('una-sentencia', 'Solo se permite una sentencia.');
  if (!/^(select|with)\b/i.test(body)) return fail('solo-lectura', 'La consulta debe empezar por SELECT o WITH.');

  const tokens = tokenize(body);
  const relationSet = new Set(relations.map((r) => r.toLowerCase()));
  const known = new Set(knownTables.map((r) => r.toLowerCase()));
  const ctes = cteNames(body);

  for (const t of tokens) {
    if (t.type !== 'ident' || t.quoted) continue;
    if (WRITE_WORDS.has(t.lower)) return fail('solo-lectura', `Palabra no permitida: ${t.value}.`);
  }
  // REPLACE is a write verb (INSERT OR REPLACE / REPLACE INTO) but also a harmless function: only the function form passes.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'ident' && !tokens[i].quoted && tokens[i].lower === 'replace' && tokens[i + 1]?.value !== '(') {
      return fail('solo-lectura', 'Palabra no permitida: REPLACE.');
    }
  }

  let depth = 0;
  for (const t of tokens) {
    if (t.type !== 'sym') continue;
    if (t.value === '(') depth++;
    if (t.value === ')') depth--;
    if (depth < 0) return fail('parentesis', 'Los paréntesis no están balanceados.');
  }
  if (depth !== 0) return fail('parentesis', 'Los paréntesis no están balanceados.');

  // Relations: after FROM / JOIN / a comma of the FROM list.
  depth = 0;
  const fromDepths = new Set();
  let relNext = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.type === 'ident' && !t.quoted ? t.lower : null;
    if (relNext) {
      if (t.type === 'sym' && t.value === '(') {
        const inner = tokens[i + 1];
        if (!inner || inner.type !== 'ident' || !['select', 'with', 'values'].includes(lowerOf(inner))) return fail('relaciones', 'Una subconsulta debe empezar por SELECT.');
        relNext = false;
      } else if (t.type === 'ident') {
        const name = t.value.toLowerCase();
        const next = tokens[i + 1];
        if (next?.type === 'sym' && (next.value === '.' || next.value === '(')) return fail('relaciones', `Relación no permitida: ${t.value}. Usa solo las vistas v_* de list_views.`);
        if (!relationSet.has(name) && !ctes.has(name)) return fail('relaciones', `Relación no permitida: ${t.value}. Usa solo las vistas v_* de list_views.`);
        relNext = false;
        continue;
      } else return fail('relaciones', 'Falta la tabla o vista después de FROM/JOIN.');
    }
    if (lower === 'from') {
      fromDepths.add(depth);
      relNext = true;
    } else if (lower === 'join') relNext = true;
    else if (t.type === 'sym' && t.value === ',' && fromDepths.has(depth)) relNext = true;
    else if (t.type === 'sym' && t.value === '(') depth++;
    else if (t.type === 'sym' && t.value === ')') {
      fromDepths.delete(depth);
      depth--;
    } else if (lower && FROM_END.has(lower)) fromDepths.delete(depth);
  }
  if (relNext) return fail('relaciones', 'Falta la tabla o vista después de FROM/JOIN.');

  // Internal tables, SQLite catalog and pragma functions are never reachable, even by alias tricks.
  for (const t of tokens) {
    if (t.type !== 'ident') continue;
    const name = t.value.toLowerCase();
    if (name.startsWith('sqlite_') || name.startsWith('pragma_')) return fail('internas', `No se permite acceder a ${t.value}.`);
    if (known.has(name) && !relationSet.has(name)) return fail('internas', `${t.value} es una tabla interna; usa las vistas v_*.`);
  }

  // Functions: any name followed by "(" that is not a keyword or a CTE declaration.
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.type !== 'ident' || next.type !== 'sym' || next.value !== '(') continue;
    if (tokens[i - 1]?.value === '.') return fail('funciones', `Función no permitida: ${t.value}.`);
    const name = t.value.toLowerCase();
    if (!t.quoted && BEFORE_PAREN.has(name)) continue;
    if (ctes.has(name)) continue;
    if (!ALLOWED_FUNCTIONS.has(name)) return fail('funciones', `Función no permitida: ${t.value}.`);
  }

  return { ok: true, sql: sql.trim().replace(/[;\s]+$/, '') };
}
