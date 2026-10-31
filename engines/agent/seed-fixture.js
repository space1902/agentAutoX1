// Test helper: a temporary data dir with a seeded ads.db (two CTs over ten days, one budget raise).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStoreAt } from '../ads/store.js';

export const day = (n) => `2026-10-${String(n).padStart(2, '0')}`;

export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// vatPct = IVA on the spend (0 keeps the hand-computed numbers of the older tests simple).
export function makeDataDir({ days = 10, raiseOn = 6, vatPct = 0 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const store = openStoreAt(dataDir);
  const insights = [];
  const sales = [];
  for (let d = 1; d <= days; d++) {
    insights.push(
      { date: day(d), adId: 'a1', adName: 'Video A', campaignId: 'c1', campaignName: 'CT07 Colombia', adsetId: 's1', adsetName: 'Set 1', gasto: 10000, impressions: 1000, clicks: 40, mensajes: 5, country: 'CO' },
      { date: day(d), adId: 'a2', adName: 'Video B', campaignId: 'c2', campaignName: 'CT08 Colombia', adsetId: 's2', adsetName: 'Set 2', gasto: 5000, impressions: 800, clicks: 20, mensajes: 2, country: 'CO' },
    );
    // CT07: one 30.000 sale a day (ROAS 3). CT08: a 6.000 sale every other day (ROAS 0,6).
    sales.push({ registered: `${day(d)} 10:00`, date: day(d), result: 'Pago válido', phone: '573001110000', valor: 30000, bank: 'Nequi', flow: 'Bebidas Colombia', adId: 'a1', adLossy: false, adUrl: '' });
    if (d % 2 === 0) sales.push({ registered: `${day(d)} 12:00`, date: day(d), result: 'Pago válido', phone: '573002220000', valor: 6000, bank: 'Nequi', flow: 'Bebidas Colombia', adId: 'a2', adLossy: false, adUrl: '' });
  }
  store.upsertInsights(insights, 1);
  store.upsertAds(
    [
      { adId: 'a1', name: 'Video A', createdTime: '2026-09-30', effectiveStatus: 'ACTIVE', campaignId: 'c1', campaignName: 'CT07 Colombia', adsetId: 's1', adsetName: 'Set 1' },
      { adId: 'a2', name: 'Video B', createdTime: '2026-09-30', effectiveStatus: 'ACTIVE', campaignId: 'c2', campaignName: 'CT08 Colombia', adsetId: 's2', adsetName: 'Set 2' },
    ],
    1,
  );
  store.refreshFirstSpend();
  store.syncComprobantes(sales, 1);
  store.setComprobanteCountries(store.comprobantesBetween('2000-01-01', '2999-12-31').map((c) => ({ key: c.key, country: 'CO', source: 'telefono' })));
  store.setSpendVat(vatPct);
  fs.mkdirSync(path.join(dataDir, 'ads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'ads', 'config.json'), JSON.stringify({ spendVatPct: vatPct }), 'utf8');
  store.setKv('account', { name: 'Test', timezone: 'America/Bogota', currency: 'COP' });
  if (raiseOn) {
    store.upsertBudgetEvents([{ entityType: 'adset', entityId: 's1', time: Date.parse(`${day(raiseOn)}T15:00:00Z`), date: day(raiseOn), oldBudget: 10000, newBudget: 12000 }]);
  }
  store.close();
  return { dataDir, now: Date.parse(`${day(days + 1)}T15:00:00Z`), cleanup: () => rmDir(dataDir) };
}
