// Daily spend ledger for the external AI: <data>/ai-usage.json, per local date and per provider/model.
// Writes are atomic (temp file + rename) so a crash never leaves a half-written ledger.
import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'ai-usage.json';
const KEEP_DAYS = 60;

const round = (value) => Math.round(value * 1e9) / 1e9;

export function localDateKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function readLedger(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, FILE_NAME), 'utf8').replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(dataDir, ledger) {
  const file = path.join(dataDir, FILE_NAME);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function dayTotals(day) {
  let usd = 0;
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const entry of Object.values(day ?? {})) {
    usd += entry.usd ?? 0;
    calls += entry.calls ?? 0;
    promptTokens += entry.promptTokens ?? 0;
    completionTokens += entry.completionTokens ?? 0;
  }
  return { usd: round(usd), calls, promptTokens, completionTokens };
}

export class UsageLedger {
  constructor(dataDir, { now = () => new Date() } = {}) {
    this.dataDir = dataDir;
    this.now = now;
    this.data = readLedger(dataDir);
  }

  record({ provider, model, promptTokens = 0, completionTokens = 0, usd = 0 }) {
    const date = localDateKey(this.now());
    const day = (this.data[date] ??= {});
    const entry = (day[`${provider}/${model}`] ??= { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0 });
    entry.calls += 1;
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.usd = round(entry.usd + usd);
    this.prune(date);
    writeLedger(this.dataDir, this.data);
  }

  todayUsd() {
    return dayTotals(this.data[localDateKey(this.now())]).usd;
  }

  prune(todayKey) {
    const [year, month, day] = todayKey.split('-').map(Number);
    const limit = localDateKey(new Date(year, month - 1, day - KEEP_DAYS));
    for (const key of Object.keys(this.data)) {
      if (key < limit) delete this.data[key];
    }
  }
}

// Today and the last 7 days (oldest first, days without spend included as zeros).
export function summarize(dataDir, now = new Date()) {
  const data = readLedger(dataDir);
  const days = [];
  for (let back = 6; back >= 0; back--) {
    const date = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    days.push({ date, ...dayTotals(data[date]), models: data[date] ?? {} });
  }
  const today = days[days.length - 1];
  return {
    todayUsd: today.usd,
    todayCalls: today.calls,
    todayPromptTokens: today.promptTokens,
    todayCompletionTokens: today.completionTokens,
    last7Usd: round(days.reduce((sum, day) => sum + day.usd, 0)),
    days,
  };
}
