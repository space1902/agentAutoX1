// Report scope helpers: the ad-name filter and the conversion of each account's spend to the base currency. Pure.
import { pickRate } from './fx.js';
import { accountsOf } from './portfolios.js';

export class ScopeError extends Error {}

const MAX_PREFIXES = 20;
const MAX_PREFIX_LENGTH = 60;
// Letters, digits, spaces and the punctuation that shows up in ad names. Nothing that could be markup or SQL syntax.
const PREFIX_CHARS = /^[\p{L}\p{N} _\-.·#+&()[\]/|:]+$/u;

// "ct, PZZ,,x" -> ["ct", "pzz", "x"]. Empty pieces are ignored; anything odd is refused (the value is only ever compared
// in JavaScript, never put into SQL).
export function parseNamePrefixes(value) {
  if (value === undefined || value === null || value === true) return [];
  const raw = String(value);
  if (raw.length > 400) throw new ScopeError('El filtro de nombre es demasiado largo.');
  const list = [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (list.length > MAX_PREFIXES) throw new ScopeError(`Usa como máximo ${MAX_PREFIXES} prefijos en el filtro de nombre.`);
  for (const p of list) {
    if (p.length > MAX_PREFIX_LENGTH || !PREFIX_CHARS.test(p)) throw new ScopeError('El filtro de nombre tiene caracteres no válidos.');
  }
  return list;
}

// Starts-with on the ad name, case-insensitive. No prefixes = everything matches.
export function matchesName(adName, prefixes) {
  if (!prefixes?.length) return true;
  const name = String(adName ?? '').trim().toLowerCase();
  return prefixes.some((p) => name.startsWith(p));
}

// COP per 1 unit of `currency` on a day: COP itself, the saved live rate, else a manual country rate with that currency.
function rateToCop(currency, date, config, fxRates) {
  if (currency === 'COP') return 1;
  const hit = pickRate(fxRates?.[currency], date);
  if (hit) return hit.rate;
  const manual = Object.values(config.countries ?? {}).find((c) => c.currency === currency && c.rateToCop > 0);
  return manual ? manual.rateToCop : null;
}

// Amount in `from` -> base currency of the config, or null when a rate is missing.
export function convertAmount(amount, from, to, date, config, fxRates) {
  if (!from || from === to) return amount;
  const a = rateToCop(from, date, config, fxRates);
  const b = rateToCop(to, date, config, fxRates);
  return a && b ? (amount * a) / b : null;
}

// { act_id: { name, currency, portfolioName } } (currency from the config, else what Meta told us).
export const accountMetaOf = (config, store) =>
  Object.fromEntries(accountsOf(config).map((a) => [a.accountId, { name: a.name, currency: a.currency || store.getKv(`account:${a.accountId}`)?.currency || '', portfolioName: a.portfolioName }]));

// Accounts whose spend is not in the base currency (the SQL views for the Analista leave them out).
export const foreignCurrencyAccounts = (config, store) =>
  Object.entries(accountMetaOf(config, store)).filter(([, m]) => m.currency && m.currency !== config.currency).map(([id]) => id);

// Keeps the insight rows of the selected accounts and ad names, with spend converted to the base currency.
// Rows whose currency cannot be converted are left out and reported in `warnings` (never silently mixed).
export function scopeInsights({ rows, accounts = null, names = [], accountMeta = {}, config, fxRates = {} }) {
  const base = config.currency;
  const warnings = [];
  const warned = new Set();
  const out = [];
  for (const r of rows) {
    if (accounts && !accounts.has(r.accountId ?? '')) continue;
    if (!matchesName(r.adName, names)) continue;
    const currency = accountMeta[r.accountId]?.currency || base;
    if (currency === base) {
      out.push(r);
      continue;
    }
    const gasto = convertAmount(r.gasto, currency, base, r.date, config, fxRates);
    if (gasto === null) {
      const key = `${r.accountId}|${currency}`;
      if (!warned.has(key)) {
        warned.add(key);
        const label = accountMeta[r.accountId]?.name || r.accountId;
        warnings.push({
          code: 'fx_missing', accountId: r.accountId, currency,
          message: `No hay tasa ${currency} → ${base}: el gasto de la cuenta ${label} no se incluyó en los totales. Actualiza los datos o configura la tasa.`,
        });
      }
      continue;
    }
    out.push({ ...r, gasto, originalGasto: r.gasto, originalCurrency: currency });
  }
  return { rows: out, warnings };
}
