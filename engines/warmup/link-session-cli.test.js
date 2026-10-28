import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(args, dataDir) {
  const out = spawnSync(process.execPath, [path.join(HERE, 'link-session-cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTAUTO_DATA_DIR: dataDir },
    timeout: 20_000,
  });
  const lines = out.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: out.status, lines };
}

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentautox1-link-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ botNumber: '573000000000', testers: [{ id: 'tester1', phone: '573001112233' }, { id: 'tester2', phone: '573004445566' }] }),
  );
  fs.mkdirSync(path.join(dir, '.baileys_auth', 'tester2'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.baileys_auth', 'tester2', 'creds.json'), JSON.stringify({ me: { id: '1:2@s.whatsapp.net' } }));
  return dir;
}

test('dry-run reports phone and linked state without opening any WhatsApp session', () => {
  const dir = dataDir();
  const unlinked = run(['--tester', 'tester1', '--dry-run'], dir);
  assert.equal(unlinked.status, 0);
  assert.deepEqual(unlinked.lines[0], { event: 'dry-run', tester: 'tester1', phone: '573001112233', linked: false });
  const linked = run(['--tester', 'tester2', '--dry-run'], dir);
  assert.equal(linked.lines[0].linked, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an already linked tester ends with already-linked and never connects', () => {
  const dir = dataDir();
  const result = run(['--tester', 'tester2'], dir);
  assert.equal(result.status, 0);
  assert.deepEqual(result.lines.map((l) => l.event), ['already-linked', 'exit']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tester without a phone or a missing --tester fails with a JSON error', () => {
  const dir = dataDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ botNumber: '573000000000', testers: ['tester9'] }));
  const noPhone = run(['--tester', 'tester9'], dir);
  assert.equal(noPhone.status, 1);
  assert.equal(noPhone.lines.find((l) => l.event === 'error').code, 'NO_PHONE');
  const noArg = run([], dir);
  assert.equal(noArg.lines.find((l) => l.event === 'error').code, 'BAD_ARGS');
  fs.rmSync(dir, { recursive: true, force: true });
});
