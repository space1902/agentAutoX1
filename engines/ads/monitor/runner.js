// Wiring of the in-app alerts monitor: the long-lived loop that monitor-cli.js `run` starts.
// Output protocol (stdout, one JSON per line): { type: 'log', line } | { type: 'status', ... } | { type: 'fatal', error }.
import fs from 'node:fs';
import path from 'node:path';

import { adsDir, loadConfig } from '../config.js';
import { fetchSheetCsv, parseComprobantes } from '../sheet.js';
import { keyRows, openStoreAt } from '../store.js';
import { loadAlertsConfig } from './alerts-config.js';
import { MetaApi } from './meta-api.js';
import { Monitor } from './monitor.js';
import { createStore } from './store.js';
import { WaClient } from './wa.js';
import { digitsOf, isFromAllowed, toJid } from './wa-protocol.js';

const OUTBOX_EVERY_MS = 20_000;
const STATUS_EVERY_MS = 10_000;

export const authDirOf = (dataDir) => path.join(adsDir(dataDir), '.baileys_auth', 'alerts');
export const monitorDbPath = (dataDir) => path.join(adsDir(dataDir), 'monitor.db');

// Phone numbers are not secrets, but they do not belong in logs: keep the last 4 digits.
export const maskPhones = (text) => String(text ?? '').replace(/\d{8,}/g, (digits) => `••••${digits.slice(-4)}`);

// Linked state and a masked number, read from the session's creds.json (nothing else is looked at).
export function readWaStatus(dataDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(authDirOf(dataDir), 'creds.json'), 'utf8'));
    const digits = digitsOf(String(creds?.me?.id ?? '').split('@')[0].split(':')[0]);
    return digits ? { linked: true, phoneMasked: `••••${digits.slice(-4)}` } : { linked: false, phoneMasked: '' };
  } catch {
    return { linked: false, phoneMasked: '' };
  }
}

// Sends the texts other parts of the app queued (daily decisions) in order; stops at the first failure.
export async function flushOutbox({ adsStore, send, now = Date.now, log = () => {} }) {
  let sent = 0;
  for (const item of adsStore.pendingWhatsapp()) {
    try {
      await send(item.text);
    } catch (error) {
      log(`aviso en cola sin enviar (${error.message}); se reintenta luego`);
      return { sent, failed: true };
    }
    adsStore.markWhatsappSent(item.id, now());
    sent++;
  }
  return { sent, failed: false };
}

const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Starts everything and returns { stop }. Throws a friendly Error when it cannot start.
export async function startMonitor({ dataDir, env = process.env, emit = line, now = Date.now, fetchImpl = globalThis.fetch }) {
  const token = String(env.AGENTAUTO_META_TOKEN ?? '').trim();
  if (!token) throw new Error('Falta el token de Meta. Impórtalo o pégalo en la configuración de Anuncios.');
  const config = loadAlertsConfig(dataDir);
  const adsConfig = loadConfig(dataDir);
  const redact = (text) => maskPhones(String(text ?? '').split(token).join('***'));
  const log = (message) => emit({ type: 'log', line: `[${new Date(now()).toISOString()}] ${redact(message)}` });

  fs.mkdirSync(adsDir(dataDir), { recursive: true });
  const store = createStore(monitorDbPath(dataDir));
  const adsStore = openStoreAt(dataDir);
  const api = new MetaApi({ token, version: adsConfig.graphVersion, readOnly: !config.allowActions, fetchImpl });

  // WhatsApp is optional: without a linked session the alerts are still logged (and shown in the app).
  const wa = new WaClient({ authDir: authDirOf(dataDir) });
  const destination = toJid(config.whatsapp.alertTo);
  let waState = readWaStatus(dataDir).linked && destination ? 'connecting' : 'unlinked';
  const send = async (text) => {
    if (waState === 'unlinked') throw new Error('WhatsApp no está vinculado');
    return wa.sendText(destination, text);
  };

  const sheetRows = config.salesSource === 'meta'
    ? null
    : async () => {
      const rows = parseComprobantes(await fetchSheetCsv({ sheetId: adsConfig.sheetId, tab: adsConfig.sheetTab, fetchImpl })).rows;
      // Payments the user accepted by hand in the app count like valid ones (the sheet itself is never changed).
      // Discarded payments never count (rejection wins over acceptance).
      const accepted = adsStore.acceptedKeys();
      const rejected = adsStore.rejectedKeys();
      return accepted.size || rejected.size ? keyRows(rows).map((r) => ({ ...r, accepted: accepted.has(r.key), rejected: rejected.has(r.key) })) : rows;
    };

  const monitor = new Monitor({
    api, store, config: { ...config, flowPrefix: adsConfig.flowPrefix, spendVatPct: adsConfig.spendVatPct, validResult: adsConfig.validResult }, accountId: adsConfig.adAccountId,
    send, saveConfig: () => {}, log, sheetRows, allowActions: config.allowActions, now,
  });

  const seen = new Set();
  wa.on('message', (message) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    if (!isFromAllowed(message, config.whatsapp.alertTo)) return;
    monitor.handleMessage(message.text).catch((error) => log(`no pude atender un mensaje: ${error.message}`));
  });
  wa.on('ready', () => { waState = 'connected'; log('WhatsApp conectado'); });
  wa.on('logged_out', () => { waState = 'unlinked'; log('La sesión de WhatsApp se cerró: vincúlala de nuevo'); });
  wa.on('fatal', (reason) => {
    waState = reason === 'CONFLICT' ? 'conflict' : 'error';
    log(reason === 'CONFLICT' ? 'Otro proceso está usando esta sesión de WhatsApp (conflicto)' : `Falló la conexión de WhatsApp (${reason})`);
  });

  if (waState !== 'unlinked') await wa.connect();
  await monitor.init();
  log(`Monitoreando ${adsConfig.adAccountId} (${monitor.tz}), campañas «${config.campaignPrefix}», cada ${config.pollMinutes} min, ventas: ${monitor.salesSource}, ${config.allowActions ? 'acciones con aprobación' : 'solo alertas'}`);

  const stopLoop = monitor.run();
  const statusTimer = setInterval(() => emit({ type: 'status', monitor: monitor.status(), wa: { state: waState, ...readWaStatus(dataDir) } }), STATUS_EVERY_MS);
  const outboxTimer = setInterval(() => {
    if (waState === 'connected') void flushOutbox({ adsStore, send, now, log });
  }, OUTBOX_EVERY_MS);
  emit({ type: 'status', monitor: monitor.status(), wa: { state: waState, ...readWaStatus(dataDir) } });

  return {
    async stop() {
      stopLoop();
      clearInterval(statusTimer);
      clearInterval(outboxTimer);
      await wa.destroy();
      store.close();
      adsStore.close();
    },
  };
}
