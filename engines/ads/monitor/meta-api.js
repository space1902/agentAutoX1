// Minimal Graph API client: versioned URLs, token in a header (never in URLs or logs), pagination,
// rate-limit awareness and a read-only mode used by dry runs.
export const GRAPH_HOST = 'graph.facebook.com';
// 17: user request limit, 80004: ads insights throttling, 613: calls to this API exceeded the rate limit.
export const BACKOFF_CODES = new Set([17, 80004, 613]);
const USAGE_LIMIT_PCT = 75;
// Development-tier apps get error 613 on two writes less than 30 s apart; keep a safety margin.
const MIN_WRITE_GAP_MS = 35_000;

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
    return JSON.parse(headers.get(name) ?? 'null');
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
      for (const e of Array.isArray(entries) ? entries : []) {
        values.push(Number(e.call_count), Number(e.total_cputime), Number(e.total_time));
      }
    }
  }

  const app = readJsonHeader(headers, 'x-app-usage');
  if (app && typeof app === 'object') values.push(Number(app.call_count), Number(app.total_cputime), Number(app.total_time));

  return { pct: Math.max(0, ...values.filter(Number.isFinite)) };
}

// API access tier of the app ("development_access", "standard_access"...), when Meta reports it.
export function parseAccessTier(headers) {
  const buc = readJsonHeader(headers, 'x-business-use-case-usage');
  if (!buc || typeof buc !== 'object') return null;
  for (const entries of Object.values(buc)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      if (typeof e?.ads_api_access_tier === 'string') return e.ads_api_access_tier;
    }
  }
  return null;
}

export class MetaApi {
  constructor({
    token, version = 'v26.0', fetchImpl = globalThis.fetch, now = Date.now, readOnly = false,
    usageLimitPct = USAGE_LIMIT_PCT, baseBackoffMs = 60_000, maxBackoffMs = 3_600_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), minWriteGapMs = MIN_WRITE_GAP_MS,
  }) {
    if (!token) throw new Error('META_ACCESS_TOKEN is missing');
    this.token = token;
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.readOnly = readOnly;
    this.usageLimitPct = usageLimitPct;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.usagePct = 0;
    this.skipNext = false;
    this.backoffMs = 0;
    this.backoffUntil = 0;
    this.accessTier = null;
    this.sleep = sleep;
    this.minWriteGapMs = minWriteGapMs;
    this.lastWriteEnd = null;
    this.writeChain = Promise.resolve();
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

  async #request(url, { method = 'GET', body } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}) });

    const { pct } = parseUsage(response.headers);
    this.usagePct = pct;
    if (pct > this.usageLimitPct) this.skipNext = true;
    this.accessTier = parseAccessTier(response.headers) ?? this.accessTier;

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

  post(path, body = {}) {
    if (this.readOnly) return Promise.reject(new Error('MetaApi is in read-only mode: write calls are disabled'));
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    const run = async () => {
      if (this.lastWriteEnd !== null) {
        const wait = this.lastWriteEnd + this.minWriteGapMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      try {
        return await this.#request(this.#url(path), { method: 'POST', body: form.toString() });
      } finally {
        this.lastWriteEnd = this.now();
      }
    };
    // Writes run one at a time, spaced by minWriteGapMs; a failed write does not block the queue.
    const result = this.writeChain.then(run);
    this.writeChain = result.catch(() => {});
    return result;
  }

  // Called once per poll. High usage skips exactly one poll; a rate-limit error skips until the
  // exponential backoff window has passed.
  shouldSkipPoll() {
    if (this.now() < this.backoffUntil) return { skip: true, reason: `rate-limit backoff for ${Math.round((this.backoffUntil - this.now()) / 1000)}s` };
    if (this.skipNext) {
      this.skipNext = false;
      return { skip: true, reason: `usage at ${this.usagePct}%` };
    }
    return { skip: false };
  }
}
