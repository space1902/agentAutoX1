// JSON CLI of the agents, used by the desktop app.
//   node --disable-warning=ExperimentalWarning agent-cli.js <command> [--agent <id>] [--stdin]
// One-shot commands print one JSON line { ok, data } / { ok: false, error }.
// Streaming commands (turn, eval-run) print one JSON event per line until they finish; a cancel signal
// (Ctrl+Break / SIGTERM) stops only the Claude Code child they started.
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
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`El Analista necesita Node 22.13 o superior (tienes ${process.versions.node}).`);
  const [command = '', ...rest] = process.argv.slice(2);
  // `--agent <id>` selects the registry entry (omitted = analista, the legacy behaviour).
  const agentAt = rest.indexOf('--agent');
  const agentId = agentAt >= 0 ? rest[agentAt + 1] : undefined;
  const jsonAt = rest.indexOf('--json');
  const payload = jsonAt >= 0 ? JSON.parse(rest[jsonAt + 1] || '{}') : rest.includes('--stdin') ? JSON.parse((await readStdin()).trim() || '{}') : {};
  const dataDir = resolveDataDir(path.join(ROOT, '..', 'warmup'));
  const api = await import('./agent-api.js');

  if (api.STREAMING.includes(command)) {
    let cancel = null;
    const onSignal = () => cancel?.();
    for (const sig of ['SIGBREAK', 'SIGTERM', 'SIGINT']) process.on(sig, onSignal);
    await api.runStreaming(command, payload, { dataDir, agentId, emit: print, registerCancel: (fn) => (cancel = fn) });
  } else {
    try {
      print({ ok: true, data: await api.runCommand(command, payload, { dataDir, agentId }) });
    } catch (error) {
      if (!(error instanceof api.AgentError)) throw error;
      print({ ok: false, error: error.message });
    }
  }
} catch (error) {
  print({ ok: false, error: String(error?.message ?? error) });
  process.exitCode = 1;
}
