import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionValue, parseInsightRow, parseHourlyRow, hourFromBreakdown, isMonitored,
  ACTION_PURCHASE, ACTION_CONVERSATION, HOURLY_BREAKDOWN as HOURLY,
} from './insights.js';

const row = {
  campaign_name: 'CT01 Bebidas', campaign_id: 'c1', adset_id: 's1', ad_id: 'a1', ad_name: 'Video 1',
  spend: '5200.5', impressions: '1000', clicks: '25', ctr: '2.5', cpm: '5200.5', frequency: '1.4',
  actions: [
    { action_type: ACTION_PURCHASE, value: '2' },
    { action_type: ACTION_CONVERSATION, value: '9' },
    { action_type: 'link_click', value: '30' },
  ],
};

test('actionValue sums matching action types and tolerates missing arrays', () => {
  assert.equal(actionValue(row.actions, ACTION_PURCHASE), 2);
  assert.equal(actionValue(undefined, ACTION_PURCHASE), 0);
  assert.equal(actionValue([{ action_type: 'x', value: 'abc' }], 'x'), 0);
});

test('parseInsightRow converts strings to numbers and extracts actions', () => {
  const r = parseInsightRow(row);
  assert.equal(r.adId, 'a1');
  assert.equal(r.campaignName, 'CT01 Bebidas');
  assert.equal(r.spend, 5200.5);
  assert.equal(r.purchases, 2);
  assert.equal(r.conversations, 9);
  assert.equal(r.frequency, 1.4);
  assert.equal(r.clicks, 25);
});

test('parseInsightRow defaults missing metrics to zero', () => {
  const r = parseInsightRow({ ad_id: 'a2', ad_name: 'x', campaign_name: 'CT02' });
  assert.equal(r.spend, 0);
  assert.equal(r.purchases, 0);
  assert.equal(r.conversations, 0);
});

test('hourFromBreakdown reads the start hour', () => {
  assert.equal(hourFromBreakdown('07:00:00 - 07:59:59'), 7);
  assert.equal(hourFromBreakdown('23:00:00 - 23:59:59'), 23);
  assert.equal(hourFromBreakdown('garbage'), null);
});

test('parseHourlyRow adds date and hour', () => {
  const r = parseHourlyRow({
    ...row, date_start: '2026-10-24', hourly_stats_aggregated_by_advertiser_time_zone: '13:00:00 - 13:59:59',
  });
  assert.equal(r.date, '2026-10-24');
  assert.equal(r.hour, 13);
  assert.equal(r.purchases, 2);
});

test('isMonitored filters by campaign prefix, case-insensitively', () => {
  assert.equal(isMonitored('CT01 Bebidas', 'CT'), true);
  assert.equal(isMonitored('ct05', 'CT'), true);
  assert.equal(isMonitored('BF Black Friday', 'CT'), false);
  assert.equal(isMonitored(undefined, 'CT'), false);
});

test('parseInsightRow and parseHourlyRow add the IVA to spend and cpm when asked', () => {
  const r = parseInsightRow({ ...row, spend: '1000', cpm: '200' }, 19);
  assert.ok(Math.abs(r.spend - 1190) < 1e-9);
  assert.ok(Math.abs(r.cpm - 238) < 1e-9);
  assert.equal(parseInsightRow({ ...row, spend: '1000' }).spend, 1000);
  assert.ok(Math.abs(parseHourlyRow({ ...row, spend: '1000', date_start: '2026-10-28', [HOURLY]: '07:00:00 - 07:59:59' }, 19).spend - 1190) < 1e-9);
});
