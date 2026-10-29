// Local text generation through Ollama. This is the only text generator in the
// project: no paid API is called, so there are no per-message charges.

const TESTER_ID = /\btester\s*\d+\b/i;
// The group is Colombian; Spain-only forms ("vosotros", "os") give the bots away.
const SPAIN_SPANISH = /\bvosotr[oa]s\b|(^|[\s¿¡,])os(?=\s)/i;
const LOCAL_ATTEMPTS = 2;

export function resolveLocalModel(config) {
  const local = config?.localModel ?? {};
  return {
    url: local.url || 'http://localhost:11434',
    model: local.model || 'qwen2.5:7b',
    cpuOnly: local.cpuOnly === true || config?.ai?.localGpu === 'cpu',
  };
}

export function cleanMessage(text) {
  return String(text ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
}

// A message that names another tester ("tester3") would expose the setup.
export function isUsableMessage(text) {
  return Boolean(text) && !TESTER_ID.test(text) && !SPAIN_SPANISH.test(text);
}

export async function generateLocal({
  url,
  model,
  system,
  prompt,
  maxTokens = 120,
  // No usable video card: ask Ollama to keep every layer on the CPU instead of probing the GPU.
  cpuOnly = false,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // Keep the model in VRAM between turns so it is not reloaded every message.
      keep_alive: '1h',
      options: { num_predict: maxTokens, temperature: 0.9, ...(cpuOnly ? { num_gpu: 0 } : {}) },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama ${response.status}: ${detail}`.trim());
  }

  const data = await response.json();
  return cleanMessage(data.message?.content);
}

// Tries the local model twice; returns null when neither attempt is sendable,
// so the caller skips the turn instead of sending something that exposes the bots.
export async function generateUsableMessage({ generate, warn = console.warn }) {
  for (let attempt = 1; attempt <= LOCAL_ATTEMPTS; attempt++) {
    try {
      const text = await generate();
      if (isUsableMessage(text)) return text;
      warn(`[local model] unusable message on attempt ${attempt}: ${JSON.stringify(text)}`);
    } catch (error) {
      // A budget stop ends the run: retrying would only repeat the refusal.
      if (error?.fatal) return null;
      warn(`[local model] failed on attempt ${attempt}: ${error?.message || error}`);
    }
  }
  return null;
}
