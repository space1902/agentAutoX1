// Non-interactive JSON CLI over profile-api.js, used by the desktop app.
//   node perfil-api.js <list|registry|create|update|delete|set-group> [--json '<payload>' | --stdin]
// Prints exactly one JSON line: { "ok": true, "data": ... } or { "ok": false, "error": "..." }.
// The data folder comes from AGENTAUTO_DATA_DIR (default: the original whatsapp-bot-tester folder).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from './data-dir.js';
import { runCommand } from './profile-api.js';
import { SelectionError } from './session-selection.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readPayload(args) {
  const jsonIndex = args.indexOf('--json');
  const text = jsonIndex !== -1 ? (args[jsonIndex + 1] ?? '') : args.includes('--stdin') ? await readStdin() : '';
  if (!text.trim()) return {};
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new SelectionError(`El payload no es un JSON válido: ${error.message}`);
  }
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  const args = process.argv.slice(2);
  const command = args[0] ?? '';
  const payload = await readPayload(args.slice(1));
  print({ ok: true, data: runCommand(command, payload, { dataDir: resolveDataDir(ROOT) }) });
} catch (error) {
  print({ ok: false, error: error.message });
  process.exitCode = error instanceof SelectionError ? 0 : 1;
}
