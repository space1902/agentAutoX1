import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PodUiError, createAdb, linkWithCode, parsePairingCode, waitForWhatsApp } from './pod-driver.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uia');
const xml = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');
const noSleep = async () => {};

// A fake pod: every dump answers with the next fixture of the script (the last one repeats).
function fakePod(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async dump() {
      calls.push(['dump']);
      return xml(script[Math.min(index++, script.length - 1)]);
    },
    async tap(x, y) {
      calls.push(['tap', x, y]);
    },
    async typeText(text) {
      calls.push(['text', text]);
    },
    async launchApp() {
      calls.push(['launch']);
    },
  };
}

const HAPPY_ES = ['chats-es', 'menu-es', 'linked-devices-es', 'link-scanner-es', 'code-entry-es', 'code-entry-es'];

test('parsePairingCode accepts XXXX-XXXX and XXXXXXXX and rejects anything else', () => {
  assert.equal(parsePairingCode('abcd-1234'), 'ABCD1234');
  assert.equal(parsePairingCode(' ABCD1234 '), 'ABCD1234');
  assert.throws(() => parsePairingCode('ABC-123'), (e) => e instanceof PodUiError && e.code === 'BAD_CODE');
  assert.throws(() => parsePairingCode('ABCD 123$'), (e) => e.code === 'BAD_CODE');
});

test('linkWithCode walks Menu > Linked devices > Link a device > phone number > code', async () => {
  const pod = fakePod(HAPPY_ES);
  const steps = [];
  const result = await linkWithCode({ adb: pod, code: 'abcd-1234', sleep: noSleep, log: (s) => steps.push(s) });

  assert.equal(result.ok, true);
  assert.equal(result.typed, true);
  assert.deepEqual(
    pod.calls.filter(([kind]) => kind !== 'dump'),
    [
      ['tap', 675, 70], // overflow
      ['tap', 510, 340], // "Dispositivos vinculados" in the menu (third item)
      ['tap', 360, 950], // "Vincular un dispositivo"
      ['tap', 360, 1140], // "Vincular con el número de teléfono"
      ['tap', 360, 470], // focus the code field
      ['text', 'ABCD1234'],
    ],
  );
  assert.deepEqual(
    steps.map((s) => s.screen),
    ['chats', 'menu', 'linked-devices', 'link-scanner', 'code-entry'],
  );
});

test('linkWithCode works with the English labels and the camera permission dialog', async () => {
  const pod = fakePod(['chats-en', 'menu-en', 'linked-devices-en', 'permission-camera-es', 'link-scanner-en', 'code-entry-en']);
  const result = await linkWithCode({ adb: pod, code: 'ZZZZ9999', sleep: noSleep });
  assert.equal(result.ok, true);
  assert.deepEqual(pod.calls.at(-1), ['text', 'ZZZZ9999']);
  assert.ok(pod.calls.some(([kind, x, y]) => kind === 'tap' && x === 360 && y === 695), 'allowed the camera permission');
});

test('linkWithCode can start from any screen of the path', async () => {
  const pod = fakePod(['link-scanner-es', 'code-entry-es']);
  const result = await linkWithCode({ adb: pod, code: 'ABCD1234', sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(pod.calls.filter(([kind]) => kind === 'tap').length, 2); // phone-number link + field focus
});

test('dry-run dumps once, reports the next move and touches nothing', async () => {
  const pod = fakePod(HAPPY_ES);
  const result = await linkWithCode({ adb: pod, code: 'ABCD1234', dryRun: true, sleep: noSleep });
  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);
  assert.equal(result.typed, false);
  assert.equal(result.screen, 'chats');
  assert.deepEqual(result.next, { type: 'tap', target: 'overflow', x: 675, y: 70 });
  assert.deepEqual(pod.calls, [['dump']]);
});

test('an unknown app on screen launches WhatsApp Business once and carries on', async () => {
  const pod = fakePod(['launcher', 'chats-es', 'menu-es', 'linked-devices-es', 'link-scanner-es', 'code-entry-es']);
  const result = await linkWithCode({ adb: pod, code: 'ABCD1234', sleep: noSleep });
  assert.equal(result.ok, true);
  assert.deepEqual(pod.calls.find(([kind]) => kind === 'launch'), ['launch']);
});

test('repeating the same tap without leaving the screen fails with NO_PROGRESS and a manual hint', async () => {
  const pod = fakePod(['chats-es', 'menu-es', 'linked-devices-es', 'code-entry-es'].slice(0, 1));
  // Same chats screen forever, but the overflow tap never leaves it: NO_PROGRESS after repeated taps.
  await assert.rejects(
    () => linkWithCode({ adb: pod, code: 'ABCD1234', sleep: noSleep }),
    (error) => {
      assert.ok(error instanceof PodUiError);
      assert.equal(error.code, 'NO_PROGRESS');
      assert.equal(error.details.screen, 'chats');
      assert.match(error.details.manualHint, /Dispositivos vinculados/);
      assert.match(error.details.manualHint, /ABCD-1234/);
      return true;
    },
  );
  assert.equal(pod.calls.filter(([kind]) => kind === 'tap').length, 3);
});

test('an identity check fails fast with VERIFY_REQUIRED and the visible texts, without touching the pod', async () => {
  const pod = fakePod(['verify-es']);
  await assert.rejects(
    () => linkWithCode({ adb: pod, code: 'ABCD1234', sleep: noSleep }),
    (error) => {
      assert.equal(error.code, 'VERIFY_REQUIRED');
      assert.ok(error.details.visible.includes('Confirma tu identidad'));
      assert.match(error.message, /identidad|huella|PIN/i);
      return true;
    },
  );
  assert.equal(pod.calls.filter(([kind]) => kind !== 'dump').length, 0);
});

test('an unrecognised screen inside WhatsApp stops with UNKNOWN_SCREEN', async () => {
  const pod = fakePod(['chats-es']);
  const broken = { ...pod, dump: async () => xml('chats-es').replace('Más opciones', 'Otra cosa') };
  await assert.rejects(
    () => linkWithCode({ adb: broken, code: 'ABCD1234', sleep: noSleep }),
    (error) => error.code === 'UNKNOWN_SCREEN' || error.code === 'ELEMENT_NOT_FOUND',
  );
});

test('linkWithCode validates the code before touching the pod', async () => {
  const pod = fakePod(HAPPY_ES);
  await assert.rejects(() => linkWithCode({ adb: pod, code: 'nope', sleep: noSleep }), (e) => e.code === 'BAD_CODE');
  assert.deepEqual(pod.calls, []);
});

// ---- waitForWhatsApp ---------------------------------------------------------------------------------

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

test('waitForWhatsApp waits for adb, boot and the WhatsApp Business window, launching it when needed', async () => {
  const clock = fakeClock();
  const states = [
    { online: false },
    { online: true, boot: false },
    { online: true, boot: true, focus: 'com.android.launcher3/.Launcher' },
    { online: true, boot: true, focus: 'com.android.launcher3/.Launcher' },
    { online: true, boot: true, focus: 'com.whatsapp.w4b/com.whatsapp.Main' },
  ];
  let i = -1;
  const launches = [];
  const current = () => states[Math.min(i, states.length - 1)];
  const adb = {
    isOnline: async () => (i++, current().online),
    bootCompleted: async () => Boolean(current().boot),
    focusedWindow: async () => current().focus ?? '',
    launchApp: async () => void launches.push(clock.now()),
  };
  const result = await waitForWhatsApp({ adb, ...clock, timeoutMs: 60_000, pollMs: 1000 });
  assert.equal(result.ready, true);
  assert.ok(launches.length >= 1);
});

test('waitForWhatsApp times out with NOT_READY and the last state', async () => {
  const clock = fakeClock();
  const adb = {
    isOnline: async () => true,
    bootCompleted: async () => false,
    focusedWindow: async () => '',
    launchApp: async () => {},
  };
  await assert.rejects(
    () => waitForWhatsApp({ adb, ...clock, timeoutMs: 5000, pollMs: 1000 }),
    (error) => error.code === 'NOT_READY' && /arranc|Android/i.test(error.message),
  );
});

// ---- createAdb (command construction only; nothing is executed) -------------------------------------

test('createAdb builds adb shell commands for the serial and never reboots', async () => {
  const seen = [];
  const run = async (file, args) => {
    seen.push([file, ...args]);
    if (args.includes('devices')) return { stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' };
    if (args.join(' ').includes('cat /sdcard/')) return { stdout: xml('chats-es'), stderr: '' };
    if (args.join(' ').includes('getprop')) return { stdout: '1\n', stderr: '' };
    if (args.join(' ').includes('mCurrentFocus')) {
      return { stdout: '  mCurrentFocus=Window{abc u0 com.whatsapp.w4b/com.whatsapp.Main}\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const adb = createAdb({ adbPath: 'HD-Adb.exe', serial: 'emulator-5554', run });
  assert.equal(await adb.isOnline(), true);
  assert.equal(await adb.bootCompleted(), true);
  assert.match(await adb.focusedWindow(), /com\.whatsapp\.w4b/);
  assert.match(await adb.dump(), /<hierarchy/);
  await adb.tap(10, 20);
  await adb.typeText('ABCD1234');
  await adb.launchApp();

  const flat = seen.map((s) => s.join(' '));
  assert.ok(flat.some((c) => c.includes('-s emulator-5554 shell input tap 10 20')));
  assert.ok(flat.some((c) => c.includes('input text ABCD1234')));
  assert.ok(flat.some((c) => c.includes('am start -n com.whatsapp.w4b/com.whatsapp.Main')));
  assert.ok(!flat.some((c) => /\breboot\b/.test(c)));
});

test('createAdb refuses text that could break out of the shell', async () => {
  const adb = createAdb({ adbPath: 'x', serial: 'emulator-5554', run: async () => ({ stdout: '', stderr: '' }) });
  await assert.rejects(() => adb.typeText('AB; rm -rf /'), /no permitido/i);
});
