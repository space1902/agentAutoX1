// JSON CLI of the Voces section, used by the desktop app.
//   node --disable-warning=ExperimentalWarning voices-cli.js <command> [--stdin]
// Prints one JSON line { ok, data } / { ok: false, error }. The ElevenLabs key arrives only in the child env
// (AGENTAUTO_ELEVEN_KEY); nothing here ever prints it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from '../warmup/data-dir.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

try {
  const [command = '', ...rest] = process.argv.slice(2);
  const payload = rest.includes('--stdin') ? JSON.parse((await readStdin()).trim() || '{}') : {};
  const dataDir = resolveDataDir(path.join(ROOT, '..', 'warmup'));
  const api = await import('./voices-api.js');
  try {
    print({ ok: true, data: await api.runVoicesCommand(command, payload, { dataDir }) });
  } catch (error) {
    if (!(error instanceof api.VoicesError)) throw error;
    print({ ok: false, error: error.message });
  }
} catch (error) {
  print({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
  process.exitCode = 1;
}
