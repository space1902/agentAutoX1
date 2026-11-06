// Append-only session event log (results/events.jsonl): ready / qr / disconnected / auth_failure /
// paused / resumed. Shared by the engine (lib.js) and the app's profile commands, so both write the same
// line format. Logging must never break a run, so every failure is swallowed. Readers
// (health-metrics.js) only count the event names they know, so a new name is always safe to add.
import fs from 'node:fs';
import path from 'node:path';

export function appendEvent(file, session, event, detail, now = new Date()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = { at: now.toISOString(), session, event };
    if (detail !== undefined && detail !== null) entry.detail = String(detail);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Ignore: the event log is best effort.
  }
}
