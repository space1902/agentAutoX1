// Portfolios (Meta Business Managers) -> ad accounts. Pure helpers shared by the sync, the report and the command layer.
// The config only keeps ids, names and currencies; each portfolio's token lives in the OS keyring and reaches the engine
// through the env var named by `tokenEnvName(slug)`. Nothing here ever logs or returns a token.

export const PRINCIPAL_ID = 'principal';
export const LEGACY_TOKEN_ENV = 'AGENTAUTO_META_TOKEN';
export const SLUG_RE = /^[a-z0-9-]{1,40}$/;
export const ACCOUNT_RE = /^act_\d{5,25}$/;
const MAX_SELECTED = 100;

export class SelectionError extends Error {}

// AGENTAUTO_META_TOKEN__OTRO_BM for the portfolio "otro-bm". Slugs never contain "_", so two slugs cannot collide.
export const tokenEnvName = (slug) => `${LEGACY_TOKEN_ENV}__${String(slug).toUpperCase().replace(/-/g, '_')}`;

// The principal portfolio also answers to the legacy single-token variable.
export function tokenFor(env, slug) {
  const own = String(env?.[tokenEnvName(slug)] ?? '').trim();
  if (own) return own;
  return slug === PRINCIPAL_ID ? String(env?.[LEGACY_TOKEN_ENV] ?? '').trim() : '';
}

export function allTokens(env, config) {
  const out = {};
  for (const p of config?.portfolios ?? []) {
    const t = tokenFor(env, p.id);
    if (t) out[p.id] = t;
  }
  return out;
}

// Ids of the accounts currently in the config (the legacy single account when there are no portfolios).
export const configuredAccountIds = (config) => targetsFor(config, null).map((a) => a.accountId);

export function redactAll(text, tokens) {
  let out = String(text ?? '');
  for (const t of tokens ?? []) if (t) out = out.split(t).join('***');
  return out;
}

export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'portafolio';
}

// [{ accountId, name, currency, timezone, portfolioId, portfolioName }] in config order.
export function accountsOf(config) {
  const out = [];
  for (const p of config?.portfolios ?? []) {
    for (const a of p.accounts ?? []) {
      out.push({ accountId: a.id, name: a.name || a.id, currency: a.currency || '', timezone: a.timezone || '', portfolioId: p.id, portfolioName: p.name });
    }
  }
  return out;
}

// Accounts selected by `--accounts`: "all" (or nothing) or a strict comma list of act_ ids that exist in the config.
// A list that covers every account counts as "all" (that is what unattributed payments need).
export function parseAccountsArg(value, config) {
  const known = targetsFor(config, null).map((a) => a.accountId);
  const raw = value === undefined || value === null || value === true ? '' : String(value).trim();
  if (!raw || raw.toLowerCase() === 'all') return { all: true, ids: known };
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > MAX_SELECTED || ids.some((id) => !ACCOUNT_RE.test(id))) {
    throw new SelectionError('Las cuentas publicitarias deben verse como act_1234567890, separadas por comas.');
  }
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length) throw new SelectionError(`La cuenta ${unknown[0]} no está en tu configuración.`);
  const all = known.every((id) => ids.includes(id));
  return { all, ids };
}

// Accounts to query/sync for a selection. A pre-portfolio config (no portfolios at all) still resolves to its single
// legacy account under the principal portfolio, so older data dirs and callers keep working.
export function targetsFor(config, selection) {
  const list = accountsOf(config);
  if (!list.length) {
    return config?.adAccountId
      ? [{ accountId: config.adAccountId, name: config.adAccountId, currency: '', timezone: '', portfolioId: PRINCIPAL_ID, portfolioName: PRINCIPAL_ID }]
      : [];
  }
  if (!selection || selection.all) return list;
  const wanted = new Set(selection.ids);
  return list.filter((a) => wanted.has(a.accountId));
}
