import assert from 'node:assert/strict';
import path from 'node:path';
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
});
