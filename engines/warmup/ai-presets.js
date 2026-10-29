// Provider presets and price table. Prices are USD per 1M tokens, checked on provider pages on
// PRICES_AS_OF; the UI shows that date and lets the user edit every price.

export const PRICES_AS_OF = '2026-10-29';

// What the warm-up sends per day, used for the "$/day" estimates.
export const DAILY_PROFILE = { messages: 4000, promptTokens: 1400, completionTokens: 70 };

// DeepSeek charges more on weekdays at 01-04 and 06-10 UTC.
const PEAK_RANGES_UTC = [
  [1, 4],
  [6, 10],
];

export const PRESETS = {
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
    models: [
      { id: 'mistralai/ministral-3b-2512', label: 'Ministral 3B', inUsd: 0.1, outUsd: 0.1 },
      { id: 'google/gemma-3-4b-it', label: 'Gemma 3 4B', inUsd: 0.05, outUsd: 0.1 },
      { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo', inUsd: 0.029, outUsd: 0.03 },
      {
        id: 'openai/gpt-oss-20b',
        label: 'gpt-oss 20B (español flojo)',
        inUsd: 0.018,
        outUsd: 0.09,
        // gpt-oss always reasons; keep it as short as the router allows.
        extraBody: { reasoning: { effort: 'low' } },
      },
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    keyHint: 'sk-…',
    models: [
      {
        id: 'deepseek-flash',
        label: 'DeepSeek Flash',
        inUsd: 0.3,
        outUsd: 1.2,
        offPeak: { inUsd: 0.15, outUsd: 0.6 },
        extraBody: { thinking: { type: 'disabled' } },
      },
    ],
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    models: [
      {
        id: 'gpt-5-nano',
        label: 'GPT-5 nano',
        inUsd: 0.05,
        outUsd: 0.4,
        extraBody: { reasoning_effort: 'minimal' },
        tokenParam: 'max_completion_tokens',
      },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyHint: 'AIza…',
    models: [
      {
        id: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash-Lite',
        inUsd: 0.1,
        outUsd: 0.4,
        extraBody: { reasoning_effort: 'none' },
      },
    ],
  },
  mistral: {
    label: 'Mistral',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    keyHint: '',
    models: [{ id: 'ministral-3b-2512', label: 'Ministral 3B', inUsd: 0.1, outUsd: 0.1 }],
  },
  // LM Studio, llama.cpp, Jan, LocalAI, vLLM... any local server that speaks /v1/chat/completions.
  'local-openai': {
    label: 'Servidor local compatible con OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    keyHint: '',
    keyOptional: true,
    models: [],
  },
  custom: {
    label: 'Otro compatible con OpenAI',
    kind: 'openai-compatible',
    baseUrl: '',
    keyHint: '',
    models: [],
  },
};

export function findModel(presetId, modelId) {
  const preset = Object.hasOwn(PRESETS, presetId) ? PRESETS[presetId] : null;
  return preset?.models.find((model) => model.id === modelId) ?? null;
}

export function isPeakUtc(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return PEAK_RANGES_UTC.some(([from, to]) => hour >= from && hour < to);
}

// { inUsd, outUsd } that applies at `date` for a model entry.
export function priceAt(model, date = new Date()) {
  if (model.offPeak && !isPeakUtc(date)) return { inUsd: model.offPeak.inUsd, outUsd: model.offPeak.outUsd };
  return { inUsd: model.inUsd, outUsd: model.outUsd };
}

export function estimateCost(price, promptTokens, completionTokens) {
  return (promptTokens * (price.inUsd ?? 0) + completionTokens * (price.outUsd ?? 0)) / 1_000_000;
}

// Average over a week: the share of peak hours decides how much of the day is billed at the peak rate.
function peakShareOfWeek() {
  const peakHoursPerWeekday = PEAK_RANGES_UTC.reduce((sum, [from, to]) => sum + (to - from), 0);
  return (5 * peakHoursPerWeekday) / (7 * 24);
}

export function estimateDaily(model, profile = DAILY_PROFILE) {
  const prompt = profile.messages * profile.promptTokens;
  const completion = profile.messages * profile.completionTokens;
  const peak = estimateCost(model, prompt, completion);
  let usdDay = peak;
  if (model.offPeak) {
    const share = peakShareOfWeek();
    usdDay = peak * share + estimateCost(model.offPeak, prompt, completion) * (1 - share);
  }
  return { usdDay, usdMonth: usdDay * 30 };
}
