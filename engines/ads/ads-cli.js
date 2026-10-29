// JSON CLI over ads-api.js, used by the desktop app.
//   node --disable-warning=ExperimentalWarning ads-cli.js <command> [--from D --to D --group ct|campaign|ad] [--json '<payload>' | --stdin]
// Prints one JSON line { ok, data } / { ok: false, error }. The Meta token arrives only in AGENTAUTO_META_TOKEN.
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

const secret = String(process.env.AGENTAUTO_META_TOKEN ?? '').trim();
const scrub = (text) => (secret ? String(text ?? '').split(secret).join('***') : String(text ?? ''));

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Anuncios necesita Node 22.13 o superior (tienes ${process.versions.node}).`);

  const { AdsError, parseArgs, runAdsCommand } = await import('./ads-api.js');
  const [command = '', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let payload = {};
  if (args.json && args.json !== true) payload = JSON.parse(args.json);
  else if (args.stdin) payload = JSON.parse((await readStdin()).trim() || '{}');
  // Command-line flags (--from/--to/--group) and a JSON payload (config-set) share one object.
  const merged = ['config-set', 'alerts-config-set'].includes(command) ? payload : { ...payload, ...args };

  try {
    print({ ok: true, data: await runAdsCommand(command, merged, { dataDir: resolveDataDir(ROOT) }) });
  } catch (error) {
    if (!(error instanceof AdsError)) throw error;
    print({ ok: false, error: scrub(error.message) });
  }
} catch (error) {
  print({ ok: false, error: scrub(error?.message || error) });
  process.exitCode = 1;
}
