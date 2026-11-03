// Live exchange rates to COP from free public sources (no key, no secrets). They update about once a day, so the app
// fetches on each data refresh (never in the background) and keeps ONE rate per currency and calendar day in the
// `fx_rates` table: past days are converted with the rate they had. The manual `rateToCop` of a country stays as the
// fallback (and the override when "Usar tasa automática" is off).
const TIMEOUT_MS = 5000;

const positive = (n) => (typeof n === 'number' || typeof n === 'string') && Number.isFinite(Number(n)) && Number(n) > 0;
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');

// Every source answers "COP per 1 unit of <currency>"; parse returns { rate, rateDate } or null.
export const FX_SOURCES = Object.freeze([
  {
    label: 'open.er-api.com',
    url: (cur) => `https://open.er-api.com/v6/latest/${cur.toUpperCase()}`,
    parse: (body) => {
      const rate = body?.rates?.COP;
      if (body?.result === 'error' || !positive(rate)) return null;
      const unix = Number(body.time_last_update_unix);
      return { rate: Number(rate), rateDate: Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toISOString().slice(0, 10) : '' };
    },
  },
  ...[
    ['currency-api (jsdelivr)', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies'],
    ['currency-api (pages.dev)', 'https://latest.currency-api.pages.dev/v1/currencies'],
  ].map(([label, base]) => ({
    label,
    url: (cur) => `${base}/${cur.toLowerCase()}.json`,
    parse: (body, cur) => {
      const rate = body?.[cur.toLowerCase()]?.cop;
      return positive(rate) ? { rate: Number(rate), rateDate: isoDate(body.date) } : null;
    },
  })),
]);

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// COP per 1 unit of `currency`, trying each source in order. Throws when none answers with a usable number.
export async function fetchRateToCop(currency, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const cur = String(currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new Error('Moneda no válida.');
  const failures = [];
  for (const source of FX_SOURCES) {
    try {
      const parsed = source.parse(await fetchJson(source.url(cur), fetchImpl, timeoutMs), cur);
      if (parsed) return { ...parsed, source: source.label };
      failures.push(`${source.label}: respuesta sin tasa`);
    } catch (error) {
      failures.push(`${source.label}: ${error?.name === 'AbortError' ? 'sin respuesta' : String(error?.message ?? error)}`);
    }
  }
  throw new Error(`No pude obtener la tasa ${cur} → COP (${failures.join('; ')}).`);
}

// history = [{ date, rate }] ascending. The latest rate on or before `date`; before any saved rate, the earliest known.
export function pickRate(history, date) {
  if (!history?.length) return null;
  let found = null;
  for (const entry of history) {
    if (entry.date <= date) found = entry;
    else break;
  }
  return found ?? history[0];
}

// Rate of a country on a day: { rate, set, mode: 'cop' | 'auto' | 'manual' | 'none', date? }.
// auto = saved live rate of that day; manual = the configured rate (override or fallback); none = nothing known (1, flagged).
export function resolveRate(config, country, date, fxRates = {}) {
  const c = config.countries?.[country];
  const currency = c?.currency ?? 'COP';
  if (currency === 'COP' || !country) return { rate: 1, set: true, mode: 'cop' };
  if (c.autoRate !== false) {
    const hit = pickRate(fxRates[currency], date);
    if (hit) return { rate: hit.rate, set: true, mode: 'auto', date: hit.date };
  }
  return c.rateToCop > 0 ? { rate: c.rateToCop, set: true, mode: 'manual' } : { rate: 1, set: false, mode: 'none' };
}

// Rate behind each enabled non-COP country on a day, with where and when it was fetched (null for manual rates).
export function fxSummary(config, fxRates, date) {
  return (config.enabledCountries ?? [])
    .filter((code) => (config.countries?.[code]?.currency ?? 'COP') !== 'COP')
    .map((code) => {
      const currency = config.countries[code].currency;
      const r = resolveRate(config, code, date, fxRates);
      const saved = r.mode === 'auto' ? fxRates[currency]?.find((e) => e.date === r.date) : null;
      return { country: code, currency, mode: r.mode, rate: r.rate, date: r.date ?? null, fetchedAt: saved?.fetchedAt ?? null, source: saved?.source ?? null };
    });
}

// Currencies of the enabled countries that follow the live rate (never COP).
export function autoCurrencies(config) {
  const out = new Set();
  for (const code of config.enabledCountries ?? []) {
    const c = config.countries?.[code];
    if (c && c.currency !== 'COP' && c.autoRate !== false) out.add(c.currency);
  }
  return [...out];
}

// Fetches each live currency once and saves today's rate. Never throws: a failed currency keeps its last saved rate
// and is reported in `errors`.
export async function refreshFxRates({ store, config, today, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  const rates = [];
  const errors = [];
  const results = await Promise.all(
    autoCurrencies(config).map(async (currency) => {
      try {
        return { currency, ...(await fetchRateToCop(currency, { fetchImpl, timeoutMs })) };
      } catch (error) {
        return { currency, error: String(error?.message ?? error) };
      }
    }),
  );
  for (const r of results) {
    if (r.error) {
      errors.push({ currency: r.currency, message: r.error });
      continue;
    }
    const saved = { currency: r.currency, date: today, rate: r.rate, fetchedAt: now(), source: r.source };
    store.saveFxRate(saved);
    rates.push(saved);
  }
  return { rates, errors };
}
