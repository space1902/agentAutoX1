// Local model servers: detection, Ollama model management (list, loaded, delete, pull) and fit hints.
// All HTTP goes through an injectable fetch so tests never touch a real server.

export const RECOMMENDED_MODELS = [
  { id: 'gemma3:4b', label: 'Gemma 3 4B', sizeGb: 3.4, memoryNeed: 'unos 5 GB de memoria de video o RAM', note: 'mejor español' },
  { id: 'qwen2.5:3b', label: 'Qwen 2.5 3B', sizeGb: 1.9, memoryNeed: 'unos 3 GB de memoria de video o RAM', note: 'liviano' },
  { id: 'gemma3:1b', label: 'Gemma 3 1B', sizeGb: 0.8, memoryNeed: 'unos 2 GB de RAM', note: 'PC sin tarjeta de video' },
];

const PROBE_TIMEOUT_MS = 1500;
const MB = 1024 * 1024;
const trimSlash = (url) => String(url).replace(/\/+$/, '');

async function getJson(fetchImpl, url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const openAiIds = (data) => (Array.isArray(data?.data) ? data.data.map((model) => model.id).filter(Boolean) : []);
const ollamaNames = (data) => (Array.isArray(data?.models) ? data.models.map((model) => model.name).filter(Boolean) : []);

async function probeOllama(fetchImpl, baseUrl) {
  const [version, tags] = await Promise.all([
    getJson(fetchImpl, `${baseUrl}/api/version`),
    getJson(fetchImpl, `${baseUrl}/api/tags`),
  ]);
  if (!version && !tags) return null;
  return { kind: 'ollama', baseUrl, version: version?.version ?? '', models: ollamaNames(tags) };
}

async function probeOpenAi(fetchImpl, baseUrl) {
  const models = await getJson(fetchImpl, `${baseUrl}/models`);
  return models ? { kind: 'openai-compatible', baseUrl, version: '', models: openAiIds(models) } : null;
}

const PORT_PROBES = [
  { id: 'ollama', name: 'Ollama', port: 11434, run: (f, host) => probeOllama(f, `http://${host}:11434`) },
  { id: 'lmstudio', name: 'LM Studio', port: 1234, run: (f, host) => probeOpenAi(f, `http://${host}:1234/v1`) },
  {
    // llama.cpp answers /health; LocalAI shares the port but does not.
    id: 'port-8080',
    port: 8080,
    run: async (f, host) => {
      const [health, found] = await Promise.all([getJson(f, `http://${host}:8080/health`), probeOpenAi(f, `http://${host}:8080/v1`)]);
      if (!found && !health) return null;
      const base = found ?? { kind: 'openai-compatible', baseUrl: `http://${host}:8080/v1`, version: '', models: [] };
      return health ? { ...base, id: 'llamacpp', name: 'llama.cpp' } : { ...base, id: 'localai', name: 'LocalAI' };
    },
  },
  { id: 'jan', name: 'Jan', port: 1337, run: (f, host) => probeOpenAi(f, `http://${host}:1337/v1`) },
  { id: 'vllm', name: 'vLLM', port: 8000, run: (f, host) => probeOpenAi(f, `http://${host}:8000/v1`) },
  {
    id: 'llamacpp-9931',
    name: 'llama.cpp',
    port: 9931,
    run: async (f, host) => {
      const [health, found] = await Promise.all([getJson(f, `http://${host}:9931/health`), probeOpenAi(f, `http://${host}:9931/v1`)]);
      if (!found && !health) return null;
      return found ?? { kind: 'openai-compatible', baseUrl: `http://${host}:9931/v1`, version: '', models: [] };
    },
  },
];

async function probeCustom(fetchImpl, rawUrl) {
  const base = trimSlash(rawUrl.trim());
  if (!base) return null;
  const openAiBase = base.endsWith('/v1') ? base : `${base}/v1`;
  const openAi = await probeOpenAi(fetchImpl, openAiBase);
  if (openAi) return { id: 'custom', name: 'URL personalizada', ...openAi };
  const ollama = await probeOllama(fetchImpl, base.replace(/\/v1$/, ''));
  return ollama ? { id: 'custom', name: 'URL personalizada', ...ollama } : null;
}

// Probes the usual local servers in parallel; returns only the ones that answered.
export async function detectServers({ fetchImpl = fetch, extraUrl = '', host = 'localhost' } = {}) {
  const jobs = PORT_PROBES.map(async (probe) => {
    const found = await probe.run(fetchImpl, host);
    return found ? { id: probe.id, name: probe.name, ...found } : null;
  });
  if (String(extraUrl ?? '').trim()) jobs.push(probeCustom(fetchImpl, extraUrl));
  return (await Promise.all(jobs)).filter(Boolean);
}

export async function listOllamaModels({ baseUrl, fetchImpl = fetch }) {
  const response = await fetchImpl(`${trimSlash(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  return (data.models ?? []).map((model) => ({
    name: model.name,
    sizeBytes: model.size ?? 0,
    parameterSize: model.details?.parameter_size ?? '',
    quantization: model.details?.quantization_level ?? '',
    modified: model.modified_at ?? '',
  }));
}

// Models loaded in memory right now, with the share that sits on the video card.
export async function psOllama({ baseUrl, fetchImpl = fetch }) {
  const response = await fetchImpl(`${trimSlash(baseUrl)}/api/ps`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  return (data.models ?? []).map((model) => {
    const size = model.size ?? 0;
    const vram = Math.min(model.size_vram ?? 0, size);
    const percentGpu = size > 0 ? Math.round((vram / size) * 100) : 0;
    return {
      name: model.name,
      sizeBytes: size,
      sizeVramBytes: vram,
      percentGpu,
      percentCpu: size > 0 ? 100 - percentGpu : 0,
      expiresAt: model.expires_at ?? '',
    };
  });
}

// `blocked`: model names that must not be removed (the one a running profile is using).
export async function deleteOllamaModel({ baseUrl, model, blocked = [], fetchImpl = fetch }) {
  if (blocked.includes(model)) {
    throw new Error(`El modelo ${model} está en uso por el perfil en curso; deténlo antes de eliminarlo.`);
  }
  const response = await fetchImpl(`${trimSlash(baseUrl)}/api/delete`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama ${response.status}: ${detail}`.trim());
  }
  return { ok: true };
}

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function validateModelTag(input) {
  const tag = String(input ?? '').trim();
  if (!tag || tag.length > 200 || !TAG_PATTERN.test(tag)) {
    throw new Error('La etiqueta del modelo no es válida. Ejemplos: gemma3:4b, qwen2.5:3b, llama3.1:8b.');
  }
  return tag;
}

function progressOf(line) {
  if (line.error) throw new Error(String(line.error));
  const done = line.status === 'success';
  const percent =
    done ? 100 : Number.isFinite(line.total) && line.total > 0 ? Math.min(100, Math.floor(((line.completed ?? 0) / line.total) * 100)) : null;
  return {
    status: line.status ?? '',
    total: line.total ?? null,
    completed: line.completed ?? null,
    percent,
    done,
  };
}

// POST /api/pull streams NDJSON. Aborting `signal` closes the connection and stops the download
// (finished layers stay on disk, so a later pull resumes).
export async function pullModel({ baseUrl, model, onProgress, signal, fetchImpl = fetch }) {
  const tag = validateModelTag(model);
  const response = await fetchImpl(`${trimSlash(baseUrl)}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: tag, stream: true }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama ${response.status}: ${detail}`.trim());
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (text) => {
    if (text.trim()) onProgress(progressOf(JSON.parse(text)));
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      flush(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  flush(buffer);
  return { ok: true };
}

// Rough rule: weights plus context cache need about 1.2x the file size in video memory.
export function fitHint(sizeBytes, gpus) {
  const card = [...gpus].filter((gpu) => gpu.kind === 'dedicated' && gpu.totalMb).sort((a, b) => b.totalMb - a.totalMb)[0];
  if (!card) return { fits: false, text: 'usará procesador y RAM' };
  return sizeBytes * 1.2 <= card.totalMb * MB
    ? { fits: true, text: 'cabe en tu tarjeta' }
    : { fits: false, text: 'no cabe, usará RAM' };
}
