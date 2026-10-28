import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'perfil-api.js');

function withData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentautox1-cli-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ groupName: 'G', botNumber: '573000000000', testers: ['tester1'] }));
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ uno: { testers: ['tester1'] } }));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const run = (dir, args, input) =>
  spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, AGENTAUTO_DATA_DIR: dir },
    input,
    encoding: 'utf8',
    timeout: 20_000,
  });

test('list via --json prints one ok JSON line', () => {
  withData((dir) => {
    const result = run(dir, ['list', '--json', '{"pods":[]}']);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.data.profiles[0].name, 'uno');
  });
});

test('payload via --stdin supports accents and quotes', () => {
  withData((dir) => {
    const payload = JSON.stringify({ name: 'niño "uno"', group: 'Grupo ñandú', selections: [{ testerId: 'tester1' }] });
    const result = run(dir, ['create', '--stdin'], payload);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
    assert.equal(saved['niño "uno"'].groupName, 'Grupo ñandú');
  });
});

test('user errors are reported as ok:false with exit code 0', () => {
  withData((dir) => {
    const result = run(dir, ['delete', '--json', '{"name":"zzz"}']);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /No existe/);
  });
});

test('invalid JSON and unknown commands fail cleanly', () => {
  withData((dir) => {
    assert.equal(JSON.parse(run(dir, ['list', '--json', '{bad']).stdout).ok, false);
    assert.match(JSON.parse(run(dir, ['nope']).stdout).error, /desconocido/);
  });
});
