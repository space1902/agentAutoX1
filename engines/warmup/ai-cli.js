// JSON CLI over ai-api.js, used by the desktop app.
//   node ai-cli.js <command> [--json '<payload>' | --stdin]
// Prints one JSON line { ok, data } / { ok: false, error }. `local-pull` instead streams NDJSON progress
// lines and ends with { type: 'done' } or { type: 'error' }. The API key arrives only in AGENTAUTO_AI_KEY.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAiCommand, runPull } from './ai-api.js';
import { resolveDataDir } from './data-dir.js';
import { SelectionError } from './session-selection.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

async function readPayload(args) {
  const jsonIndex = args.indexOf('--json');
  let text = '';
  if (jsonIndex !== -1) text = args[jsonIndex + 1] ?? '';
  else if (args.includes('--stdin')) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new SelectionError(`El payload no es un JSON válido: ${error.message}`);
  }
}

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const [command = '', ...rest] = process.argv.slice(2);
  const payload = await readPayload(rest);
  const dataDir = resolveDataDir(ROOT);
  if (command === 'local-pull') {
    try {
      await runPull(payload, { dataDir, write: print });
    } catch (error) {
      print({ type: 'error', error: String(error?.message || error) });
      process.exitCode = 1;
    }
  } else {
    print({ ok: true, data: await runAiCommand(command, payload, { dataDir }) });
  }
} catch (error) {
  print({ ok: false, error: error.message });
  process.exitCode = error instanceof SelectionError ? 0 : 1;
}
