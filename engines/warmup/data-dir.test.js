import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { dataPaths, defaultDataDir, resolveDataDir } from './data-dir.js';

const CODE_ROOT = path.resolve('/projects/agentAutoX1/engines/warmup');

test('defaults to the original whatsapp-bot-tester folder next to agentAutoX1', () => {
  assert.equal(defaultDataDir(CODE_ROOT), path.resolve('/projects/whatsapp-bot-tester'));
  assert.equal(resolveDataDir(CODE_ROOT, {}), defaultDataDir(CODE_ROOT));
});

test('AGENTAUTO_DATA_DIR overrides the default', () => {
  const dir = path.resolve('/somewhere/else');
  assert.equal(resolveDataDir(CODE_ROOT, { AGENTAUTO_DATA_DIR: dir }), dir);
});

test('blank AGENTAUTO_DATA_DIR falls back to the default', () => {
  assert.equal(resolveDataDir(CODE_ROOT, { AGENTAUTO_DATA_DIR: '   ' }), defaultDataDir(CODE_ROOT));
});

test('dataPaths derives every data location from the data dir', () => {
  const paths = dataPaths(path.resolve('/d'));
  assert.equal(paths.configFile, path.resolve('/d/config.json'));
  assert.equal(paths.profilesFile, path.resolve('/d/profiles.json'));
  assert.equal(paths.authDir, path.resolve('/d/.baileys_auth'));
  assert.equal(paths.resultsDir, path.resolve('/d/results'));
  assert.equal(paths.envFile, path.resolve('/d/.env'));
  assert.equal(paths.pausesFile, path.resolve('/d/warmup-pauses.json'));
});

test('under node --test the real data folder is never the default (a temp folder is used instead)', () => {
  const dir = resolveDataDir(CODE_ROOT, { NODE_TEST_CONTEXT: 'child-v8' });
  assert.notEqual(dir, defaultDataDir(CODE_ROOT));
  assert.ok(dir.startsWith(path.resolve(os.tmpdir())));
  assert.equal(resolveDataDir(CODE_ROOT, { NODE_TEST_CONTEXT: 'child-v8' }), dir, 'stable inside one process');
});

test('an explicit AGENTAUTO_DATA_DIR still wins under node --test', () => {
  const dir = path.resolve('/chosen');
  assert.equal(resolveDataDir(CODE_ROOT, { NODE_TEST_CONTEXT: 'child-v8', AGENTAUTO_DATA_DIR: dir }), dir);
});
