// One WhatsApp number over Baileys (WebSocket, no browser). Trimmed from
// ../whatsapp-bot-tester/wa-client.js: events 'pairing_code' | 'pairing_failed' | 'ready' | 'message' | 'logged_out' | 'fatal'
// (no QR: linking is always by pairing code).
// Baileys is loaded lazily and can be injected, so tests never connect.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyDisconnect, normalizeIncoming, reconnectDelayMs } from './wa-protocol.js';

const READY_WAIT_MS = 30_000;

// Baileys is installed with the warm-up engine (engines/warmup/node_modules), not here.
const WARMUP_BAILEYS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'warmup', 'node_modules', 'baileys', 'lib', 'index.js');

async function loadBaileys() {
  let baileys;
  try {
    baileys = await import('baileys');
  } catch {
    baileys = await import(pathToFileURL(WARMUP_BAILEYS).href);
  }
  return {
    makeWASocket: baileys.makeWASocket ?? baileys.default,
    useMultiFileAuthState: baileys.useMultiFileAuthState,
    fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
  };
}

// Baileys is chatty at every level; keep only its errors.
function createLogger(tag) {
  const logger = {
    level: 'error',
    child: () => logger,
    trace() {}, debug() {}, info() {}, warn() {},
    error(first, second) {
      const detail = typeof first === 'string' ? first : (second ?? first?.err?.message ?? first?.message ?? '');
      if (detail) console.warn(`[${tag}] baileys: ${detail}`);
    },
  };
  return logger;
}

export class WaClient extends EventEmitter {
  // pairingPhone: link by PAIRING CODE (never by QR). Without it an unlinked session just waits.
  constructor({ authDir, tag = 'alerts', load = loadBaileys, readyWaitMs = READY_WAIT_MS, pairingPhone = '' }) {
    super();
    this.pairingPhone = String(pairingPhone ?? '').replace(/\D/g, '');
    this.pairingAttempts = new WeakMap();
    this.authDir = authDir;
    this.tag = tag;
    this.load = load;
    this.readyWaitMs = readyWaitMs;
    this.sock = null;
    this.state = null;
    this.ready = false;
    this.stopped = false;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.pendingSave = Promise.resolve();
  }

  get linked() {
    return Boolean(this.state?.creds?.me);
  }

  async connect() {
    await this.#open();
  }

  async #open() {
    if (this.stopped) return;
    const baileys = await this.load();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authDir);
    const version = await Promise.resolve(baileys.fetchLatestBaileysVersion?.()).then((r) => r?.version).catch(() => undefined);
    if (this.stopped) return;

    this.state = state;
    const sock = baileys.makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: createLogger(this.tag),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      emitOwnEvents: false,
    });
    this.sock = sock;
    const current = (handler) => (payload) => { if (this.sock === sock) handler(payload); };

    sock.ev.on('creds.update', current(() => {
      this.pendingSave = this.pendingSave.then(() => saveCreds()).catch((e) => console.warn(`[${this.tag}] could not save credentials: ${e?.message || e}`));
    }));
    sock.ev.on('connection.update', current((update) => this.#onConnection(update)));
    sock.ev.on('messages.upsert', current(({ type, messages }) => {
      if (type !== 'notify') return; // 'append' is history and our own echoes
      for (const raw of messages ?? []) {
        const message = normalizeIncoming(raw);
        if (message) this.emit('message', message);
      }
    }));
  }

  #onConnection({ connection, lastDisconnect, qr }) {
    if (qr) this.#onQr(this.sock);
    if (connection === 'open') {
      this.ready = true;
      this.attempts = 0;
      this.emit('ready');
      return;
    }
    if (connection !== 'close') return;

    this.ready = false;
    if (this.stopped) return;
    const status = lastDisconnect?.error?.output?.statusCode;
    const action = classifyDisconnect(status);
    if (action === 'logged-out') return void this.emit('logged_out');
    if (action === 'replaced' || action === 'fatal') return void this.emit('fatal', action === 'replaced' ? 'CONFLICT' : `FATAL:${status}`);
    this.#scheduleReconnect(action === 'restart' ? 0 : reconnectDelayMs(this.attempts++));
  }

  // A QR event means "not linked yet". The QR itself is discarded: with a phone we ask for a pairing code, once per socket.
  #onQr(sock) {
    if (!this.pairingPhone || this.linked || !sock || this.pairingAttempts.get(sock)) return;
    this.pairingAttempts.set(sock, true);
    Promise.resolve(sock.requestPairingCode(this.pairingPhone))
      .then((code) => this.emit('pairing_code', String(code).replace(/(.{4})(?=.)/g, '$1-')))
      .catch((error) => this.emit('pairing_failed', error instanceof Error ? error : new Error(String(error))));
  }

  #scheduleReconnect(delayMs) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.stopped) return;
      const previous = this.sock;
      try {
        await this.#open();
      } catch (error) {
        console.warn(`[${this.tag}] reconnect failed: ${error?.message || error}`);
        this.#scheduleReconnect(reconnectDelayMs(this.attempts++));
        return;
      }
      try { previous?.end(undefined); } catch { /* already closed */ }
    }, delayMs);
  }

  async #liveSocket() {
    if (this.ready && this.sock) return this.sock;
    if (this.stopped) throw new Error('WhatsApp session is closed');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('ready', onReady);
        reject(new Error('WhatsApp session is not connected'));
      }, this.readyWaitMs);
      const onReady = () => { clearTimeout(timer); resolve(); };
      this.once('ready', onReady);
    });
    return this.sock;
  }

  async sendText(jid, text) {
    const sock = await this.#liveSocket();
    const sent = await sock.sendMessage(jid, { text: String(text) });
    if (!sent?.key?.id) throw new Error('WhatsApp did not confirm the message');
    return sent.key.id;
  }

  async destroy() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    await this.pendingSave;
    try { this.sock?.end(undefined); } catch { /* already closed */ }
    this.removeAllListeners();
  }
}
