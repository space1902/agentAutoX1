// CLI used by the desktop app to drive one pod. Prints one JSON object per line:
//   {"event":"step",...}  progress
//   {"event":"done",...}  success (exit 0)
//   {"event":"error","code","message","details"}  failure (exit 1)
//
//   node pod-driver-cli.js ready --adb <HD-Adb.exe> --serial <serial> [--timeout <seconds>]
//   node pod-driver-cli.js link  --adb <HD-Adb.exe> --serial <serial> --code ABCD-1234 [--dry-run]
//   node pod-driver-cli.js link  --fixture <dump.xml> --code ABCD-1234 --dry-run     (offline, no adb)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { PodUiError, createAdb, linkWithCode, waitForWhatsApp } from './pod-driver.js';

export function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

const print = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

export async function main(argv) {
  const { command, flags } = parseArgs(argv);
  try {
    if (command === 'link' && flags.fixture) {
      const xml = fs.readFileSync(flags.fixture, 'utf8');
      const adb = { dump: async () => xml };
      print({ event: 'done', ...(await linkWithCode({ adb, code: flags.code, dryRun: true })) });
      return 0;
    }
    if (!flags.adb || !flags.serial) throw new PodUiError('BAD_ARGS', 'Faltan --adb y --serial.');
    const adb = createAdb({ adbPath: flags.adb, serial: flags.serial });
    const log = (info) => print({ event: 'step', ...info });

    if (command === 'ready') {
      const timeoutMs = (Number(flags.timeout) || 240) * 1000;
      print({ event: 'done', ...(await waitForWhatsApp({ adb, timeoutMs, log })) });
      return 0;
    }
    if (command === 'link') {
      print({ event: 'done', ...(await linkWithCode({ adb, code: flags.code, dryRun: flags['dry-run'] === true, log })) });
      return 0;
    }
    throw new PodUiError('BAD_ARGS', `Comando desconocido: ${command}. Usa ready o link.`);
  } catch (error) {
    print({
      event: 'error',
      code: error instanceof PodUiError ? error.code : 'UNEXPECTED',
      message: error.message,
      details: error instanceof PodUiError ? error.details : {},
    });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
