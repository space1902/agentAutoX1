// Long-lived processes of the Alertas panel, started and stopped by the desktop app.
//   node --disable-warning=ExperimentalWarning monitor-cli.js run
//   node --disable-warning=ExperimentalWarning monitor-cli.js link --phone 573001234567
// Output: one JSON object per line. The Meta token arrives only in AGENTAUTO_META_TOKEN.
// Stop: Ctrl+Break (SIGBREAK) / SIGINT / SIGTERM close the WhatsApp session cleanly before exiting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from '../warmup/data-dir.js';
import { parseArgs } from './ads-api.js';
import { normalizePhone } from './monitor/alerts-config.js';
import { authDirOf, maskPhones, readWaStatus, startMonitor } from './monitor/runner.js';
import { WaClient } from './monitor/wa.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir(ROOT);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const secret = String(process.env.AGENTAUTO_META_TOKEN ?? '').trim();
const scrub = (text) => maskPhones(secret ? String(text ?? '').split(secret).join('***') : String(text ?? ''));

function onStop(handler) {
  let called = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => {
      if (called) return;
      called = true;
      Promise.resolve(handler()).finally(() => process.exit(0));
    });
  }
}

async function run() {
  const handle = await startMonitor({ dataDir });
  onStop(() => handle.stop());
}

// Links the sender number by PAIRING CODE (never a QR): prints the code, waits for WhatsApp to confirm.
async function link(phone) {
  const digits = normalizePhone(phone);
  if (!digits) throw new Error('Escribe el número del remitente con código de país.');
  fs.mkdirSync(authDirOf(dataDir), { recursive: true });
  const wa = new WaClient({ authDir: authDirOf(dataDir), pairingPhone: digits });
  const finish = async (event, code = 0) => {
    print(event);
    await new Promise((r) => setTimeout(r, 3000)); // let the credentials flush to disk
    await wa.destroy();
    process.exit(code);
  };
  onStop(() => wa.destroy());
  wa.on('pairing_code', (code) => print({ type: 'pairing_code', code }));
  wa.on('pairing_failed', (error) => void finish({ type: 'error', error: `No se pudo pedir el código de vinculación: ${scrub(error.message)}` }, 1));
  wa.on('ready', () => void finish({ type: 'linked', ...readWaStatus(dataDir) }));
  wa.on('logged_out', () => void finish({ type: 'error', error: 'WhatsApp cerró la sesión. Vuelve a intentarlo.' }, 1));
  wa.on('fatal', (reason) => void finish({ type: 'error', error: `Falló la conexión de WhatsApp (${reason}).` }, 1));
  setTimeout(() => void finish({ type: 'error', error: 'Se acabó el tiempo sin vincular (5 min). Vuelve a intentarlo.' }, 1), 5 * 60_000).unref();
  await wa.connect();
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Anuncios necesita Node 22.13 o superior (tienes ${process.versions.node}).`);
  const [command = '', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'run') await run();
  else if (command === 'link') await link(args.phone);
  else throw new Error(`Comando no permitido: ${command}.`);
} catch (error) {
  print({ type: 'fatal', error: scrub(error?.message || error) });
  process.exit(1);
}
