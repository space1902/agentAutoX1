import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './pod-driver-cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (...args) => spawnSync(process.execPath, [path.join(HERE, 'pod-driver-cli.js'), ...args], { encoding: 'utf8' });
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

test('parseArgs splits the command and --flags, with boolean flags', () => {
  assert.deepEqual(parseArgs(['link', '--serial', 'emulator-5554', '--dry-run', '--code', 'ABCD-1234']), {
    command: 'link',
    flags: { serial: 'emulator-5554', 'dry-run': true, code: 'ABCD-1234' },
  });
});

test('offline dry-run over a fixture reports the next move and exits 0 (no adb involved)', () => {
  const fixture = path.join(HERE, 'fixtures', 'uia', 'chats-es.xml');
  const out = run('link', '--fixture', fixture, '--code', 'ABCD-1234', '--dry-run');
  assert.equal(out.status, 0);
  const result = lastJson(out.stdout);
  assert.equal(result.event, 'done');
  assert.equal(result.dryRun, true);
  assert.equal(result.screen, 'chats');
  assert.equal(result.next.target, 'overflow');
});

test('errors are one JSON line with code, message and details, and exit 1', () => {
  const out = run('link', '--fixture', path.join(HERE, 'fixtures', 'uia', 'chats-es.xml'), '--code', 'nope', '--dry-run');
  assert.equal(out.status, 1);
  const result = lastJson(out.stdout);
  assert.equal(result.event, 'error');
  assert.equal(result.code, 'BAD_CODE');

  const missing = run('ready');
  assert.equal(missing.status, 1);
  assert.equal(lastJson(missing.stdout).code, 'BAD_ARGS');
});
