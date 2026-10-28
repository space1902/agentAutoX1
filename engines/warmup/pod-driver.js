// Drives WhatsApp Business inside a BlueStacks pod over adb to link it with a Baileys pairing code:
//   Menu > Linked devices > Link a device > Link with phone number > type the 8-character code.
// All decisions come from pod-ui.js (selector map + screen recognition); this module only loops
// "dump -> recognise -> act" with an injected adb, so it is tested with fixtures and a fake pod.
//
// BlueStacks gotchas respected here: only `input`, `uiautomator`, `am start`, `dumpsys`, `getprop` and `cat` are used
// (never `adb reboot`), the adb serial is `emulator-<port-1>`, and HD-Adb may print results on stderr.
import { execFile } from 'node:child_process';

import { identifyScreen, nextAction, parseHierarchy, visibleTexts } from './pod-ui.js';

export const WA_PACKAGE = 'com.whatsapp.w4b';
export const WA_ACTIVITY = 'com.whatsapp.Main';
const DUMP_FILE = '/sdcard/agentautox1-ui.xml';
const MAX_SAME_TAP = 3;

export class PodUiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PodUiError';
    this.code = code;
    this.details = details;
  }
}

// "abcd-1234" | "ABCD1234" -> "ABCD1234"
export function parsePairingCode(input) {
  const code = String(input ?? '').trim().replace(/-/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    throw new PodUiError('BAD_CODE', 'El código de vinculación debe tener 8 caracteres (letras y números), por ejemplo ABCD-1234.');
  }
  return code;
}

const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

const SCREEN_NAMES = {
  chats: 'lista de chats',
  menu: 'menú ⋮',
  'linked-devices': 'Dispositivos vinculados',
  permission: 'permiso de la cámara',
  'link-scanner': 'escáner QR',
  'code-entry': 'código de 8 caracteres',
  verify: 'verificación de identidad',
  'other-app': 'otra aplicación',
  unknown: 'pantalla desconocida',
};

export function manualHint(code) {
  return (
    'Termina a mano en la ventana del pod: WhatsApp Business > Menú ⋮ > Dispositivos vinculados > Vincular un dispositivo > ' +
    `Vincular con el número de teléfono, y escribe el código ${pretty(code)}.`
  );
}

function fail(errorCode, message, { screen, nodes, code, target }) {
  throw new PodUiError(errorCode, message, {
    screen,
    screenName: SCREEN_NAMES[screen] ?? screen,
    target: target ?? null,
    visible: visibleTexts(nodes ?? []),
    manualHint: manualHint(code),
  });
}

const ABORT_MESSAGES = {
  VERIFY_REQUIRED: 'WhatsApp pide confirmar tu identidad (huella, PIN o patrón) y eso no se puede automatizar.',
  UNKNOWN_SCREEN: 'No reconozco la pantalla actual de WhatsApp Business.',
  ELEMENT_NOT_FOUND: 'No encontré el botón que necesito en esta pantalla.',
};

// Runs the whole path. `dryRun` only reads the screen (one dump) and reports what it would do.
export async function linkWithCode({ adb, code, dryRun = false, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxSteps = 16, settleMs = 1500 }) {
  const pairing = parsePairingCode(code);
  let last = { key: '', count: 0 };
  let steps = 0;
  let launched = false;

  for (;;) {
    const nodes = parseHierarchy(await adb.dump());
    const screen = identifyScreen(nodes);
    const action = nextAction(screen, nodes, { code: pairing });
    log({ screen, action: action.type, target: action.target ?? null });

    if (dryRun) return { ok: true, dryRun: true, typed: false, screen, next: action };

    if (action.type === 'abort') {
      const message = ABORT_MESSAGES[action.reason] ?? 'No pude seguir con la vinculación.';
      fail(action.reason, message, { screen, nodes, code: pairing, target: action.target });
    }

    if (++steps > maxSteps) fail('TOO_MANY_STEPS', 'La vinculación dio demasiadas vueltas sin llegar al código.', { screen, nodes, code: pairing });

    if (action.type === 'launch') {
      if (launched) fail('NOT_IN_WHATSAPP', 'No logro abrir WhatsApp Business en el pod.', { screen, nodes, code: pairing });
      launched = true;
      await adb.launchApp();
      await sleep(settleMs * 2);
      continue;
    }

    if (action.type === 'type') {
      if (action.focus) {
        await adb.tap(action.focus.x, action.focus.y);
        await sleep(400);
      }
      await adb.typeText(action.text);
      await sleep(settleMs);
      return { ok: true, dryRun: false, typed: true, screen, steps };
    }

    const key = `${screen}:${action.target}`;
    last = last.key === key ? { key, count: last.count + 1 } : { key, count: 1 };
    if (last.count > MAX_SAME_TAP) {
      fail('NO_PROGRESS', `Toqué «${action.target}» varias veces y la pantalla no cambió.`, { screen, nodes, code: pairing, target: action.target });
    }
    await adb.tap(action.x, action.y);
    await sleep(settleMs);
  }
}

// Waits until adb sees the device, Android finished booting and WhatsApp Business is in the foreground
// (launching it when Android is up but another app is showing).
export async function waitForWhatsApp({ adb, timeoutMs = 240_000, pollMs = 3000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const deadline = now() + timeoutMs;
  let state = 'adb';
  let polls = 0;

  while (now() < deadline) {
    polls++;
    if (!(await adb.isOnline())) state = 'adb';
    else if (!(await adb.bootCompleted())) state = 'boot';
    else {
      const focus = await adb.focusedWindow();
      if (focus.includes(WA_PACKAGE)) return { ready: true, polls };
      state = 'launch';
      if (polls % 3 === 0) await adb.launchApp();
    }
    log({ state });
    await sleep(pollMs);
  }

  const reasons = {
    adb: 'adb no ve el pod todavía',
    boot: 'Android sigue arrancando',
    launch: 'WhatsApp Business no llegó a abrirse',
  };
  throw new PodUiError('NOT_READY', `El pod no quedó listo a tiempo: ${reasons[state]}. Revisa su ventana de BlueStacks.`, { state });
}

const defaultRun = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

// Thin adb wrapper for one pod. `run(file, args)` is injectable for tests.
export function createAdb({ adbPath, serial, run = defaultRun }) {
  const shell = (...args) => run(adbPath, ['-s', serial, 'shell', ...args]);

  return {
    async isOnline() {
      const { stdout } = await run(adbPath, ['devices']);
      return new RegExp(`^${serial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+device\\b`, 'm').test(stdout);
    },
    async bootCompleted() {
      const { stdout } = await shell('getprop', 'sys.boot_completed');
      return stdout.trim() === '1';
    },
    async focusedWindow() {
      const { stdout, stderr } = await shell('dumpsys window | grep mCurrentFocus');
      return `${stdout}${stderr}`.trim();
    },
    async dump() {
      for (let attempt = 0; attempt < 3; attempt++) {
        await shell('uiautomator', 'dump', DUMP_FILE);
        const { stdout } = await shell('cat', DUMP_FILE);
        if (stdout.includes('<hierarchy')) return stdout;
      }
      throw new PodUiError('DUMP_FAILED', 'No pude leer la pantalla del pod (uiautomator no respondió).');
    },
    async tap(x, y) {
      await shell('input', 'tap', String(Math.round(x)), String(Math.round(y)));
    },
    async typeText(text) {
      if (!/^[A-Za-z0-9]+$/.test(text)) throw new PodUiError('BAD_TEXT', 'Texto no permitido para escribir en el pod.');
      await shell('input', 'text', text);
    },
    async launchApp() {
      await shell('am', 'start', '-n', `${WA_PACKAGE}/${WA_ACTIVITY}`);
    },
  };
}
