import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOGGED_OUT_DIR, archiveLoggedOutSession } from './session-archive.js';
import { hasSavedSession } from './session-selection.js';

const withTemp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('archiveLoggedOutSession moves the session under _logged_out with a timestamp and never deletes it', () =>
  withTemp((root) => {
    fs.mkdirSync(path.join(root, 'tester1'));
    fs.writeFileSync(path.join(root, 'tester1', 'creds.json'), JSON.stringify({ me: { id: '1:2@s.whatsapp.net' } }));

    const dest = archiveLoggedOutSession(root, 'tester1', new Date('2026-10-27T15:04:05.123Z'));

    assert.equal(dest, path.join(root, LOGGED_OUT_DIR, 'tester1-2026-10-27T15-04-05'));
    assert.ok(fs.existsSync(path.join(dest, 'creds.json')));
    assert.equal(fs.existsSync(path.join(root, 'tester1')), false);
    assert.equal(hasSavedSession(root, 'tester1'), false);
  }));

test('archiveLoggedOutSession returns null when there is nothing to move and avoids name clashes', () =>
  withTemp((root) => {
    assert.equal(archiveLoggedOutSession(root, 'tester9'), null);

    const now = new Date('2026-10-27T15:04:05Z');
    for (let i = 0; i < 2; i++) {
      fs.mkdirSync(path.join(root, 'tester1'));
      fs.writeFileSync(path.join(root, 'tester1', 'f'), String(i));
      archiveLoggedOutSession(root, 'tester1', now);
    }
    assert.equal(fs.readdirSync(path.join(root, LOGGED_OUT_DIR)).length, 2);
  }));
