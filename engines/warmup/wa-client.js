// One WhatsApp number over Baileys (WebSocket, no browser). WaClient hides the library behind the
// small surface the bots use: events 'qr' / 'pairing_code' / 'ready' / 'message' / 'message_create' /
// 'disconnected' / 'logged_out' / 'fatal', plus sendText, sendVoice, sendImage, setPresence and
// listGroups, plus the group admin calls (groupMembers, groupParticipants, addToGroup,
// inviteCode, joinByInvite). With a phone number, an unlinked session emits 'pairing_code' (XXXX-XXXX) instead
// of 'qr'. The Baileys module is loaded lazily and can be injected, so tests never connect.
import { EventEmitter } from 'node:events';

import { appendActivity, activityRecord, readActivity } from './wa-activity.js';
import {
  classifyDisconnect,
  createRecentMap,
  jidDigits,
  lidDigits,
  normalizeMessage,
  reconnectDelayMs,
  toJid,
  voiceNoteContent,
} from './wa-messages.js';

const SENT_CACHE_SIZE = 50;
const GROUP_CACHE_TTL_MS = 10 * 60_000;
const READY_WAIT_MS = 30_000;

async function loadBaileys() {
  const baileys = await import('baileys');
  return {
    makeWASocket: baileys.makeWASocket ?? baileys.default,
    useMultiFileAuthState: baileys.useMultiFileAuthState,
    fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
  };
}

// http(s):// and socks:// proxies. The agent libraries are only loaded when a proxy is configured.
export async function createProxyAgent(url) {
  const protocol = new URL(url).protocol;
  if (protocol.startsWith('socks')) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(url);
}

// Baileys is chatty at every level; keep only its errors, tagged with the session id.
function createLogger(id) {
  const logger = {
    level: 'error',
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error(first, second) {
      const detail = typeof first === 'string' ? first : (second ?? first?.err?.message ?? first?.message ?? '');
      if (detail) console.warn(`[${id}] baileys: ${detail}`);
    },
  };
  return logger;
}

// The WhatsApp version Baileys must announce changes often; ask once per process and share the answer.
let latestVersion = null;
function resolveVersion(fetchLatest) {
  if (!latestVersion) {
    latestVersion = Promise.resolve()
      .then(() => fetchLatest?.())
      .then((result) => result?.version)
      .catch(() => undefined);
  }
  return latestVersion;
}

export class WaClient extends EventEmitter {
  constructor({
    id,
    authDir,
    activityDir,
    proxy = null,
    phone = null,
    loadBaileys: load = loadBaileys,
    createProxyAgent: makeAgent = createProxyAgent,
    reconnectDelay = reconnectDelayMs,
    readyWaitMs = READY_WAIT_MS,
  }) {
    super();
    this.id = id;
    this.authDir = authDir;
    this.activityDir = activityDir;
    this.proxy = proxy;
    this.phone = phone;
    this.load = load;
    this.makeAgent = makeAgent;
    this.reconnectDelay = reconnectDelay;
    this.readyWaitMs = readyWaitMs;

    this.sock = null;
    this.state = null;
    this.ready = false;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pendingSave = Promise.resolve();
    this.sentCache = createRecentMap(SENT_CACHE_SIZE);
    this.groupCache = new Map();
    // Per socket: has a pairing code been requested (and did it fail)? The QR event repeats every ~20s.
    this.pairingAttempts = new WeakMap();
  }

  // Listener errors must not break message processing; async listeners handle their own errors.
  emit(event, ...args) {
    let handled = false;
    // rawListeners keeps once() wrappers, so one-shot listeners still remove themselves.
    for (const listener of this.rawListeners(event)) {
      handled = true;
      try {
        const result = listener.apply(this, args);
        if (typeof result?.catch === 'function') {
          result.catch((error) => this.#warnListener(event, error));
        }
      } catch (error) {
        this.#warnListener(event, error);
      }
    }
    return handled;
  }

  #warnListener(event, error) {
    console.warn(`[${this.id}] "${event}" listener failed: ${error?.message || error}`);
  }

  get info() {
    const me = this.sock?.user ?? this.state?.creds?.me;
    if (!me) return null;
    return {
      pushname: me.name ?? this.state?.creds?.me?.name ?? null,
      wid: { user: jidDigits(me.id), ...(lidDigits(me.lid) ? { lid: lidDigits(me.lid) } : {}) },
      platform: 'baileys',
    };
  }

  async connect() {
    await this.#openSocket();
  }

  async #openSocket() {
    if (this.stopped) return;

    const baileys = await this.load();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authDir);
    const version = await resolveVersion(baileys.fetchLatestBaileysVersion);
    const agent = this.proxy ? await this.makeAgent(this.proxy) : undefined;
    if (this.stopped) return;

    this.state = state;
    const sock = baileys.makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: createLogger(this.id),
      // Light footprint: no history download, no "online" flag, no echo of our own sends.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      emitOwnEvents: false,
      getMessage: async (key) => this.sentCache.get(key?.id),
      cachedGroupMetadata: async (jid) => this.#cachedGroup(jid),
      ...(agent ? { agent, fetchAgent: agent } : {}),
    });
    this.sock = sock;

    // Events of a socket we already replaced must not touch the current state.
    const current = (handler) => (payload) => {
      if (this.sock === sock) handler(payload);
    };

    sock.ev.on(
      'creds.update',
      current(() => {
        this.pendingSave = this.pendingSave.then(() => saveCreds()).catch((error) => {
          console.warn(`[${this.id}] could not save credentials: ${error?.message || error}`);
        });
      }),
    );
    sock.ev.on('connection.update', current((update) => this.#onConnectionUpdate(update, sock)));
    sock.ev.on('messages.upsert', current((upsert) => this.#onUpsert(upsert)));
    sock.ev.on('group-participants.update', current((update) => this.groupCache.delete(update?.id)));
    sock.ev.on('groups.update', current((updates) => {
      for (const update of updates ?? []) this.groupCache.delete(update?.id);
    }));
  }

  #onConnectionUpdate({ connection, lastDisconnect, qr }, sock) {
    if (qr) this.#onQr(qr, sock);

    if (connection === 'open') {
      this.ready = true;
      this.reconnectAttempts = 0;
      this.emit('ready');
      return;
    }

    if (connection !== 'close') return;

    this.ready = false;
    if (this.stopped) return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const action = classifyDisconnect(statusCode);
    // A number that was never linked only sees QR expiries here; those are not incidents.
    const linked = Boolean(this.state?.creds?.me);

    if (action === 'logged-out') {
      this.emit('logged_out');
      this.emit('disconnected', 'LOGOUT');
      return;
    }

    if (action === 'replaced' || action === 'fatal') {
      const reason = action === 'replaced' ? 'CONFLICT' : `FATAL:${statusCode}`;
      this.emit('disconnected', reason);
      this.emit('fatal', reason);
      return;
    }

    if (action === 'retry' && linked) this.emit('disconnected', String(statusCode ?? 'closed'));
    this.#scheduleReconnect(action === 'restart' ? 0 : this.reconnectDelay(this.reconnectAttempts++));
  }

  // Unlinked + phone configured: ask for an 8-character pairing code once per socket instead of
  // showing a QR. If WhatsApp refuses, fall back to the QR so the session can still be linked.
  #onQr(qr, sock) {
    const usePairing = this.phone && !this.state?.creds?.registered;
    if (!usePairing) {
      this.emit('qr', qr);
      return;
    }

    const attempt = this.pairingAttempts.get(sock);
    if (attempt === 'failed') {
      this.emit('qr', qr);
      return;
    }
    if (attempt) return;

    this.pairingAttempts.set(sock, 'requested');
    sock
      .requestPairingCode(this.phone)
      .then((code) => {
        if (this.sock !== sock) return;
        this.emit('pairing_code', formatPairingCode(code));
      })
      .catch((error) => {
        console.warn(`[${this.id}] could not request a pairing code, using the QR: ${error?.message || error}`);
        this.pairingAttempts.set(sock, 'failed');
        if (this.sock === sock) this.emit('qr', qr);
      });
  }

  #scheduleReconnect(delayMs) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.stopped) return;
      const previous = this.sock;
      try {
        await this.#openSocket();
      } catch (error) {
        console.warn(`[${this.id}] reconnect failed: ${error?.message || error}`);
        this.#scheduleReconnect(this.reconnectDelay(this.reconnectAttempts++));
        return;
      }
      endSocket(previous);
    }, delayMs);
  }

  #onUpsert({ type, messages }) {
    // 'append' carries history and our own echoes; only 'notify' is live traffic.
    if (type !== 'notify') return;

    for (const raw of messages ?? []) {
      const msg = normalizeMessage(raw);
      if (!msg) continue;

      this.#logActivity(msg);
      this.emit('message_create', msg);
      if (!msg.fromMe) this.emit('message', msg);
    }
  }

  #logActivity(msg) {
    const record = activityRecord(msg);
    if (record) appendActivity(this.activityDir, this.id, record);
  }

  readActivity(sinceSeconds) {
    return readActivity(this.activityDir, this.id, sinceSeconds);
  }

  #cachedGroup(jid) {
    const entry = this.groupCache.get(jid);
    if (!entry) return undefined;
    if (Date.now() - entry.at > GROUP_CACHE_TTL_MS) {
      this.groupCache.delete(jid);
      return undefined;
    }
    return entry.metadata;
  }

  // Resolves with the live socket, waiting for a reconnect in progress before giving up.
  async #liveSocket() {
    if (this.ready && this.sock) return this.sock;
    if (this.stopped) throw new Error(`[${this.id}] WhatsApp session is not connected (closed)`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('ready', onReady);
        reject(new Error(`[${this.id}] WhatsApp session is not connected`));
      }, this.readyWaitMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('ready', onReady);
    });
    return this.sock;
  }

  async #send(jid, content) {
    const sock = await this.#liveSocket();
    const sent = await sock.sendMessage(jid, content);
    if (!sent?.key?.id) throw new Error(`[${this.id}] WhatsApp did not confirm the message`);

    if (sent.message) this.sentCache.set(sent.key.id, sent.message);
    this.#logActivity({
      from: jid,
      fromMe: true,
      type: content.audio ? 'ptt' : content.image ? 'image' : 'chat',
      body: content.text ?? content.caption ?? '',
      timestamp: Number(sent.messageTimestamp?.toNumber?.() ?? sent.messageTimestamp) || Math.floor(Date.now() / 1000),
    });
    return { id: { id: sent.key.id } };
  }

  sendText(jid, text) {
    return this.#send(jid, { text: String(text) });
  }

  sendVoice(jid, oggBuffer) {
    return this.#send(jid, voiceNoteContent(oggBuffer));
  }

  sendImage(jid, buffer, caption = '') {
    return this.#send(jid, { image: buffer, caption });
  }

  // 'composing' (typing), 'recording' (voice) or 'paused'.
  async setPresence(jid, state) {
    const sock = await this.#liveSocket();
    await sock.sendPresenceUpdate(state, jid);
  }

  async listGroups() {
    const sock = await this.#liveSocket();
    const groups = await sock.groupFetchAllParticipating();
    const now = Date.now();
    return Object.values(groups).map((group) => {
      this.groupCache.set(group.id, { at: now, metadata: group });
      return { id: group.id, name: group.subject ?? '' };
    });
  }

  // Members of a group, read fresh from WhatsApp (not from the send cache). Baileys 7 reports each
  // participant as { id, phoneNumber?, lid? } where id is a phone jid or a @lid. Relied on:
  //   phone jid id -> its digits; @lid id with phoneNumber -> phoneNumber's digits;
  //   lid (from id or from the lid field) -> collected in lids. A @lid without phoneNumber has no
  //   known phone, so it only shows up in lids. Callers must treat "not found" as "unknown".
  async groupMembers(jid) {
    const sock = await this.#liveSocket();
    const metadata = await sock.groupMetadata(jid);
    const phones = new Set();
    const lids = new Set();
    for (const participant of metadata?.participants ?? []) {
      for (const value of [participant.id, participant.phoneNumber, participant.jid]) {
        const phone = jidDigits(value);
        if (phone) phones.add(phone);
      }
      for (const value of [participant.id, participant.lid]) {
        const lid = lidDigits(value);
        if (lid) lids.add(lid);
      }
    }
    return { phones: [...phones], lids: [...lids] };
  }

  // Digit-only phone numbers of the group members whose phone is known.
  async groupParticipants(jid) {
    return (await this.groupMembers(jid)).phones;
  }

  // Adds phone numbers to a group (this session must be admin). One { jid, status } per participant:
  // '200' added, '409' already a member, '403' / '408' / others could not be added.
  async addToGroup(jid, digitsArray) {
    const sock = await this.#liveSocket();
    const jids = digitsArray.map((digits) => toJid(digits));
    const results = await sock.groupParticipantsUpdate(jid, jids, 'add');
    this.groupCache.delete(jid);
    return (results ?? []).map((result) => ({ jid: result.jid, status: String(result.status ?? '') }));
  }

  async inviteCode(jid) {
    const sock = await this.#liveSocket();
    return sock.groupInviteCode(jid);
  }

  // Joins a group with an invite code; resolves with the group jid.
  async joinByInvite(code) {
    const sock = await this.#liveSocket();
    return sock.groupAcceptInvite(code);
  }

  async destroy() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    await this.pendingSave;
    endSocket(this.sock);
    this.removeAllListeners();
  }
}

// 'ABCD1234' -> 'ABCD-1234'
function formatPairingCode(code) {
  const clean = String(code ?? '').replace(/[^A-Za-z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function endSocket(sock) {
  try {
    sock?.end(undefined);
  } catch {
    // The socket may already be closed.
  }
}
