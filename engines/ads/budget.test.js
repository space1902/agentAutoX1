import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeChanges, detectIncreases, parseActivity } from './budget.js';

const h = (date, dailyBudget, firstSeen = 0) => ({ date, dailyBudget, lifetimeBudget: null, firstSeen });

test('detectIncreases reports only raises of the daily budget, with the percentage', () => {
  const changes = detectIncreases([h('2026-10-20', 5000000), h('2026-10-22', 6000000), h('2026-10-25', 4000000), h('2026-10-27', 5000000)]);
  assert.deepEqual(changes.map((c) => [c.date, c.oldBudget, c.newBudget, Math.round(c.pct)]), [
    ['2026-10-22', 5000000, 6000000, 20],
    ['2026-10-27', 4000000, 5000000, 25],
  ]);
});

test('the first snapshot is a baseline, never a change; null budgets are ignored', () => {
  assert.deepEqual(detectIncreases([h('2026-10-20', 5000000)]), []);
  assert.deepEqual(detectIncreases([h('2026-10-20', null), h('2026-10-21', 5000000)]), []);
  assert.deepEqual(detectIncreases([]), []);
});

test('parseActivity understands ad set and campaign budget events in the account timezone', () => {
  const adset = parseActivity(
    { event_type: 'update_ad_set_budget', object_id: 's1', event_time: '2026-10-29T02:30:00+0000', extra_data: JSON.stringify({ old_value: '5000000', new_value: '6000000' }) },
    'America/Bogota',
  );
  assert.deepEqual(adset, { entityType: 'adset', entityId: 's1', time: Date.parse('2026-10-29T02:30:00Z'), date: '2026-10-28', oldBudget: 5000000, newBudget: 6000000 });
  const campaign = parseActivity(
    { event_type: 'update_campaign_budget', object_id: 'c1', event_time: '2026-10-29T15:00:00+0000', extra_data: { old_value: { daily_budget: 100 }, new_value: { daily_budget: 150 } } },
    'America/Bogota',
  );
  assert.equal(campaign.entityType, 'campaign');
  assert.equal(campaign.newBudget, 150);
});

test('parseActivity skips other events and unreadable payloads', () => {
  assert.equal(parseActivity({ event_type: 'update_ad_status', object_id: 's1', event_time: '2026-10-29T02:30:00+0000' }, 'UTC'), null);
  assert.equal(parseActivity({ event_type: 'update_ad_set_budget', object_id: 's1', event_time: '2026-10-29T02:30:00+0000', extra_data: 'garbage' }, 'UTC'), null);
  assert.equal(parseActivity({ event_type: 'update_ad_set_budget', event_time: '2026-10-29T02:30:00+0000', extra_data: '{"old_value":1,"new_value":2}' }, 'UTC'), null);
});

test('computeChanges prefers exact activity events and keeps snapshot-only changes as best effort', () => {
  const histories = {
    'adset|s1': [h('2026-10-20', 5000000), h('2026-10-29', 6000000)],
    'adset|s2': [h('2026-10-20', 1000000), h('2026-10-28', 1500000)],
  };
  const events = [{ entityType: 'adset', entityId: 's1', time: Date.parse('2026-10-27T15:00:00Z'), date: '2026-10-27', oldBudget: 5000000, newBudget: 6000000 }];
  const changes = computeChanges({ histories, events });
  const s1 = changes.filter((c) => c.entityId === 's1');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].date, '2026-10-27');
  assert.equal(s1[0].exact, true);
  const s2 = changes.filter((c) => c.entityId === 's2');
  assert.equal(s2[0].exact, false);
  assert.equal(s2[0].date, '2026-10-28');
});

test('computeChanges ignores activity decreases and gives every change a stable id', () => {
  const events = [{ entityType: 'adset', entityId: 's1', time: 1, date: '2026-10-27', oldBudget: 6000000, newBudget: 5000000 }];
  assert.deepEqual(computeChanges({ histories: {}, events }), []);
  const [c] = computeChanges({ histories: { 'adset|s1': [h('2026-10-20', 5), h('2026-10-22', 6)] }, events: [] });
  assert.equal(c.id, 'adset:s1:2026-10-22:6');
});

test('computeChanges annotates the previous change of the same entity', () => {
  const [first, second] = computeChanges({
    histories: { 'adset|s1': [h('2026-10-10', 100), h('2026-10-14', 120), h('2026-10-20', 150)] },
    events: [],
  });
  assert.equal(first.previous, null);
  assert.deepEqual([second.previous.date, Math.round(second.previous.pct)], ['2026-10-14', 20]);
});
