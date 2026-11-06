// JSON CLI over ads-api.js, used by the desktop app.
//   node --disable-warning=ExperimentalWarning ads-cli.js <command> [--from D --to D --group ct|campaign|ad] [--json '<payload>' | --stdin]
// Prints one JSON line { ok, data } / { ok: false, error }. Meta tokens arrive only in AGENTAUTO_META_TOKEN (principal) and AGENTAUTO_META_TOKEN__<SLUG> (one per portfolio).
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

// Every Meta token in the environment (the legacy one and one per portfolio) is scrubbed from anything printed.
const secrets = Object.entries(process.env)
  .filter(([name]) => name === 'AGENTAUTO_META_TOKEN' || name.startsWith('AGENTAUTO_META_TOKEN__'))
  .map(([, value]) => String(value ?? '').trim())
  .filter(Boolean);
const scrub = (text) => secrets.reduce((out, secret) => out.split(secret).join('***'), String(text ?? ''));

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
