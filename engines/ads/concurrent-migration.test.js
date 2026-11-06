import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// A pre-portfolio data dir: legacy config + a database without account_id.
function legacyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-concurrent-'));
  fs.mkdirSync(path.join(dir, 'ads'));
  fs.writeFileSync(path.join(dir, 'ads', 'config.json'), JSON.stringify({ adAccountId: 'act_555555' }));
  const db = new DatabaseSync(path.join(dir, 'ads', 'ads.db'));
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE insights (date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
      adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
      mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', PRIMARY KEY (date, ad_id, country));
    CREATE TABLE ads (ad_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_time TEXT NOT NULL, effective_status TEXT NOT NULL,
      campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, updated_at INTEGER NOT NULL, first_spend_date TEXT);
    CREATE TABLE budget_history (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, date TEXT NOT NULL,
      daily_budget REAL, lifetime_budget REAL, first_seen INTEGER NOT NULL);
    CREATE TABLE budget_events (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, time INTEGER NOT NULL, date TEXT NOT NULL,
      old_budget REAL NOT NULL, new_budget REAL NOT NULL, PRIMARY KEY (entity_type, entity_id, time, new_budget));
    INSERT INTO insights VALUES ('2026-10-28','1','a','c','CT','s','S',5,1,1,1,1,'');
    INSERT INTO kv VALUES ('account', '{"name":"X","timezone":"America/Bogota","currency":"COP"}');`);
  db.close();
  return dir;
}

const run = (dir) =>
  new Promise((resolve) => {
    const code = `import { openStoreAt } from ${JSON.stringify(pathToFileURL(path.join(here, 'store.js')).href)};
      import { ensureMigrated } from ${JSON.stringify(pathToFileURL(path.join(here, 'config.js')).href)};
      ensureMigrated(process.argv[1]); const s = openStoreAt(process.argv[1]); s.close();`;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (status) => resolve({ status, err }));
  });

test('several processes migrating the same pre-portfolio data dir at once all succeed', async () => {
  for (let round = 0; round < 3; round++) {
    const dir = legacyDir();
    const results = await Promise.all(Array.from({ length: 6 }, () => run(dir)));
    for (const r of results) assert.equal(r.status, 0, r.err.split('\n').slice(0, 4).join(' | '));
    const db = new DatabaseSync(path.join(dir, 'ads', 'ads.db'), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM insights WHERE account_id = 'act_555555'").get().n, 1);
    db.close();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ads', 'config.json'), 'utf8')).portfolios[0].accounts[0].id, 'act_555555');
  }
});
