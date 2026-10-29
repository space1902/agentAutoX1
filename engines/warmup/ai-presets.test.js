import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_PROFILE,
  PRESETS,
  PRICES_AS_OF,
  estimateCost,
  estimateDaily,
  findModel,
  isPeakUtc,
  priceAt,
} from './ai-presets.js';

test('presets expose the verified providers and no Anthropic entry', () => {
  assert.equal(PRICES_AS_OF, '2026-10-29');
  assert.deepEqual(Object.keys(PRESETS), ['openrouter', 'mistral', 'deepseek', 'openai', 'gemini', 'local-openai', 'custom']);
  assert.equal(PRESETS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(PRESETS.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(PRESETS.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(PRESETS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  assert.equal(PRESETS.mistral.baseUrl, 'https://api.mistral.ai/v1');
  assert.ok(!JSON.stringify(PRESETS).toLowerCase().includes('anthropic'));
});

test('findModel returns the preset model with its prices', () => {
  const nano = findModel('openai', 'gpt-5-nano');
  assert.equal(nano.inUsd, 0.05);
  assert.equal(nano.outUsd, 0.4);
  assert.equal(findModel('openai', 'nope'), null);
  assert.equal(findModel('nope', 'x'), null);
});

test('reasoning models carry minimal-effort extras and DeepSeek disables thinking', () => {
  assert.equal(findModel('openai', 'gpt-5-nano').extraBody.reasoning_effort, 'minimal');
  assert.equal(findModel('openai', 'gpt-5-nano').tokenParam, 'max_completion_tokens');
  assert.deepEqual(findModel('deepseek', 'deepseek-flash').extraBody, { thinking: { type: 'disabled' } });
  assert.equal(findModel('gemini', 'gemini-2.5-flash-lite').extraBody.reasoning_effort, 'none');
  assert.ok(findModel('openrouter', 'openai/gpt-oss-20b').extraBody.reasoning);
});

test('DeepSeek peak hours are 01-04 and 06-10 UTC on weekdays', () => {
  const at = (iso) => new Date(iso);
  // 2026-10-29 is a Thursday, 2026-10-31 a Saturday.
  assert.equal(isPeakUtc(at('2026-10-29T01:00:00Z')), true);
  assert.equal(isPeakUtc(at('2026-10-29T03:59:00Z')), true);
  assert.equal(isPeakUtc(at('2026-10-29T04:00:00Z')), false);
  assert.equal(isPeakUtc(at('2026-10-29T06:00:00Z')), true);
  assert.equal(isPeakUtc(at('2026-10-29T10:00:00Z')), false);
  assert.equal(isPeakUtc(at('2026-10-31T07:00:00Z')), false);
});

test('priceAt applies off-peak prices only to models that define them', () => {
  const flash = findModel('deepseek', 'deepseek-flash');
  assert.deepEqual(priceAt(flash, new Date('2026-10-29T07:00:00Z')), { inUsd: 0.3, outUsd: 1.2 });
  assert.deepEqual(priceAt(flash, new Date('2026-10-29T12:00:00Z')), { inUsd: 0.15, outUsd: 0.6 });
  const nano = findModel('openai', 'gpt-5-nano');
  assert.deepEqual(priceAt(nano, new Date('2026-10-29T07:00:00Z')), { inUsd: 0.05, outUsd: 0.4 });
});

test('estimateCost converts tokens at USD per million', () => {
  assert.equal(estimateCost({ inUsd: 0.1, outUsd: 0.1 }, 1_000_000, 500_000), 0.15);
  assert.equal(estimateCost({ inUsd: 0, outUsd: 0 }, 5000, 5000), 0);
});

test('estimateDaily uses 4,000 messages of ~1,400 in / 70 out tokens', () => {
  assert.deepEqual(DAILY_PROFILE, { messages: 4000, promptTokens: 1400, completionTokens: 70 });
  const nemo = findModel('openrouter', 'mistralai/mistral-nemo');
  const day = estimateDaily(nemo);
  // 4000 * (1400*0.029 + 70*0.030) / 1e6 = 0.1708
  assert.ok(Math.abs(day.usdDay - 0.1708) < 1e-9);
  assert.ok(Math.abs(day.usdMonth - 0.1708 * 30) < 1e-9);
});

test('estimateDaily blends DeepSeek peak and off-peak hours', () => {
  const flash = findModel('deepseek', 'deepseek-flash');
  const day = estimateDaily(flash);
  const peak = estimateCost(flash, 4000 * 1400, 4000 * 70);
  const off = estimateCost({ inUsd: 0.15, outUsd: 0.6 }, 4000 * 1400, 4000 * 70);
  assert.ok(day.usdDay > off && day.usdDay < peak);
});

test('only OpenRouter and Mistral are marked as recommended, and they come first', () => {
  const recommended = Object.entries(PRESETS).filter(([, preset]) => preset.recommended).map(([id]) => id);
  assert.deepEqual(recommended, ['openrouter', 'mistral']);
  assert.deepEqual(Object.keys(PRESETS).slice(0, 2), recommended);
});
