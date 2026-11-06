// Where the warm-up engine keeps its DATA (config.json, profiles.json, .baileys_auth/, results/, .env).
// Code lives in this folder; data stays in one place so WhatsApp (Signal) sessions are never duplicated.
// Configure it with AGENTAUTO_DATA_DIR; the default is the original whatsapp-bot-tester folder.
import os from 'node:os';
import path from 'node:path';

// <repo>/engines/warmup -> sibling of the agentAutoX1 folder.
export function defaultDataDir(codeRoot) {
  return path.resolve(codeRoot, '..', '..', '..', 'whatsapp-bot-tester');
}

export function resolveDataDir(codeRoot, env = process.env) {
  const configured = String(env.AGENTAUTO_DATA_DIR ?? '').trim();
  if (configured) return path.resolve(configured);
  // node --test sets NODE_TEST_CONTEXT in every test process. Tests must never read or write the real data
  // folder (events.jsonl, pauses, config), so without an explicit folder they get a private temp one.
  if (env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `agentautox1-test-data-${process.pid}`);
  return defaultDataDir(codeRoot);
}

export function dataPaths(dataDir) {
  return {
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    profilesFile: path.join(dataDir, 'profiles.json'),
    authDir: path.join(dataDir, '.baileys_auth'),
    resultsDir: path.join(dataDir, 'results'),
    envFile: path.join(dataDir, '.env'),
    // Pause state of the warm-up numbers (see pause-state.js).
    pausesFile: path.join(dataDir, 'warmup-pauses.json'),
  };
}
