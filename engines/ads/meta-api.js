// Minimal READ-ONLY Graph API client (copied and trimmed from meta-ads-monitor): versioned URLs, the token in a
// Bearer header (never in URLs or logs), pagination, rate-limit awareness and error sanitizing.
export const GRAPH_HOST = 'graph.facebook.com';
// 17: user request limit, 80004: ads insights throttling, 613: calls to this API exceeded the rate limit.
export const BACKOFF_CODES = new Set([17, 80004, 613]);
const USAGE_LIMIT_PCT = 75;

export class MetaApiError extends Error {
  constructor(message, { code, status, subcode, userTitle, userMessage, isTransient } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.code = code;
    this.status = status;
    this.subcode = subcode;
    this.userTitle = userTitle;
    this.userMessage = userMessage;
    this.isTransient = isTransient;
  }
}

function readJsonHeader(headers, name) {
  try {
    return JSON.parse(headers?.get?.(name) ?? 'null');
  } catch {
    return null;
  }
}

// Highest usage percentage reported by Meta's rate-limit headers (0 when absent or unreadable).
export function parseUsage(headers) {
  const values = [];
  const account = readJsonHeader(headers, 'x-ad-account-usage');
  if (account && typeof account === 'object') values.push(Number(account.acc_id_util_pct));

  const buc = readJsonHeader(headers, 'x-business-use-case-usage');
  if (buc && typeof buc === 'object') {
    for (const entries of Object.values(buc)) {
      for (const e of Array.isArray(entries) ? entries : []) values.push(Number(e.call_count), Number(e.total_cputime), Number(e.total_time));
    }
  }

  const app = readJsonHeader(headers, 'x-app-usage');
  if (app && typeof app === 'object') values.push(Number(app.call_count), Number(app.total_cputime), Number(app.total_time));

  return { pct: Math.max(0, ...values.filter(Number.isFinite)) };
}

export class MetaApi {
  constructor({
    token, version = 'v26.0', fetchImpl = globalThis.fetch, now = Date.now, usageLimitPct = USAGE_LIMIT_PCT,
    baseBackoffMs = 60_000, maxBackoffMs = 3_600_000,
  }) {
    if (!token) throw new Error('META_ACCESS_TOKEN is missing');
    this.token = token;
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.usageLimitPct = usageLimitPct;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.usagePct = 0;
    this.backoffMs = 0;
    this.backoffUntil = 0;
  }

  #sanitize(text) {
    return String(text ?? '').split(this.token).join('***');
  }

  #url(path, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const qs = query.toString();
    return `https://${GRAPH_HOST}/${this.version}${path}${qs ? `?${qs}` : ''}`;
  }

  async #request(url) {
    if (this.now() < this.backoffUntil) {
      throw new MetaApiError(`Meta pidió esperar ${Math.ceil((this.backoffUntil - this.now()) / 1000)} s antes de volver a consultar.`, { code: 17 });
    }
    let response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } });
    } catch (error) {
      throw new MetaApiError(`No se pudo conectar con Meta: ${this.#sanitize(error?.message)}`, { code: 'NETWORK' });
    }
    this.usagePct = parseUsage(response.headers).pct;

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) {
      const error = data?.error ?? {};
      if (BACKOFF_CODES.has(error.code)) {
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, this.maxBackoffMs) : this.baseBackoffMs;
        this.backoffUntil = this.now() + this.backoffMs;
      }
      const clean = (value) => (value == null ? undefined : this.#sanitize(value));
      throw new MetaApiError(this.#sanitize(error.message ?? `HTTP ${response.status}`), {
        code: error.code,
        status: response.status,
        subcode: error.error_subcode,
        userTitle: clean(error.error_user_title),
        userMessage: clean(error.error_user_msg),
        isTransient: error.is_transient,
      });
    }
    this.backoffMs = 0;
    this.backoffUntil = 0;
    return data;
  }

  get(path, params) {
    return this.#request(this.#url(path, params));
  }

  // Follows paging.next (only on the Graph host) and returns the concatenated `data` arrays.
  async getAll(path, params) {
    const items = [];
    let url = this.#url(path, params);
    while (url) {
      const page = await this.#request(url);
      items.push(...(page.data ?? []));
      const next = page.paging?.next;
      if (next && new URL(next).hostname !== GRAPH_HOST) throw new MetaApiError('Refusing to follow a pagination link to another host');
      url = next ?? null;
    }
    return items;
  }
}

// Friendly Spanish text for the UI. Never includes the token (MetaApi already sanitized the message).
export function friendlyMetaError(error) {
  const code = error?.code;
  if (code === 190 || code === 102 || error?.status === 401) return 'Token vencido o inválido. Pega un token nuevo en la configuración de Anuncios.';
  if (code === 200 || code === 10 || code === 294 || (code >= 200 && code <= 299)) {
    return 'El token no tiene permisos para esta cuenta publicitaria (revisa ads_read y que la cuenta sea la correcta).';
  }
  if (BACKOFF_CODES.has(code)) return 'Meta está limitando las consultas. Espera unos minutos y vuelve a intentar.';
  if (code === 'NETWORK') return String(error.message);
  if (code === 100) return `Meta rechazó la consulta: ${error.message}`;
  return `Meta respondió con un error: ${error?.message ?? 'desconocido'}`;
}
