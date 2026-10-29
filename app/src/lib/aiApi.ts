// Typed wrappers for the "IA" section (engine commands run through `ai_call`; keys live in the Windows
// Credential Manager and never come back to the UI except masked).
import { invoke } from "@tauri-apps/api/core";

export interface AiConfig {
  provider: "ollama" | "openai-compatible";
  preset?: string;
  baseUrl?: string;
  model?: string;
  dailyBudgetUsd?: number;
  onBudgetExceeded?: "fallback-local" | "stop";
  fallbackLocalModel?: string;
  localGpu?: "auto" | "cpu";
  prices?: { inUsd: number; outUsd: number };
  extraBody?: Record<string, unknown>;
}

export interface PresetModel {
  id: string;
  label: string;
  inUsd: number;
  outUsd: number;
  offPeak: { inUsd: number; outUsd: number } | null;
  usdDay: number;
  usdMonth: number;
}

export interface Preset {
  id: string;
  label: string;
  recommended: boolean;
  baseUrl: string;
  keyHint: string;
  keyOptional: boolean;
  models: PresetModel[];
}

export interface PresetsData {
  pricesAsOf: string;
  profile: { messages: number; promptTokens: number; completionTokens: number };
  presets: Preset[];
}

export interface Fit {
  fits: boolean;
  text: string;
}

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  modified: string;
  fit: Fit;
  inUse: boolean;
}

export interface LocalServer {
  id: string;
  name: string;
  kind: "ollama" | "openai-compatible";
  baseUrl: string;
  version: string;
  models: string[];
}

export interface Gpu {
  name: string;
  kind: "dedicated" | "integrated";
  totalMb: number | null;
  usedMb: number | null;
}

export interface RecommendedModel {
  id: string;
  label: string;
  sizeGb: number;
  memoryNeed: string;
  note: string;
  installed: boolean;
  fit: Fit;
}

export interface LocalDetect {
  servers: LocalServer[];
  gpus: Gpu[];
  gpu: { hasDedicated: boolean; text: string; card: Gpu | null };
  ollama: { baseUrl: string; version: string; installedModels: InstalledModel[] } | null;
  recommended: RecommendedModel[];
  suggestedForCpu: string[];
  activeModels: string[];
}

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  percentGpu: number;
  percentCpu: number;
}

export interface Resources {
  loaded: LoadedModel[];
  resources: { ram: { totalMb: number; usedMb: number }; gpus: { name: string; totalMb: number; usedMb: number }[] };
}

export interface UsageDay {
  date: string;
  usd: number;
  calls: number;
}

export interface Usage {
  todayUsd: number;
  todayCalls: number;
  last7Usd: number;
  days: UsageDay[];
}

export interface TestSample {
  ok: boolean;
  text: string;
  error?: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  usd: number;
}

export interface TestResult {
  label: string;
  samples: TestSample[];
  okCount: number;
  avgLatencyMs: number;
  estimate: { usdDay: number; usdMonth: number; messages: number; promptTokens: number; completionTokens: number };
}

export interface KeyStatus {
  present: boolean;
  masked: string;
}

export interface PullEvent {
  type: "progress" | "done" | "error" | "cancelled";
  model: string;
  status?: string;
  percent?: number | null;
  error?: string;
}

export interface InstallEvent {
  stage: string;
  message: string;
  done: boolean;
  ok: boolean;
}

const call = <T>(command: string, payload: unknown = {}) => invoke<T>("ai_call", { command, payload });

export const aiApi = {
  presets: () => call<PresetsData>("presets"),
  getConfig: () => call<{ ai: AiConfig | null; localModel: { model?: string; url?: string } | null }>("config-get"),
  saveConfig: (ai: AiConfig) => call<{ ai: AiConfig }>("config-save", { ai }),
  usage: () => call<Usage>("ai-usage"),
  test: (ai: AiConfig) => call<TestResult>("ai-test", { ai }),
  detect: (extraUrl = "") => call<LocalDetect>("local-detect", { extraUrl }),
  resources: () => call<Resources>("local-resources"),
  deleteModel: (model: string) => call<{ ok: boolean }>("local-delete", { model }),
  keyStatus: (presets: string[]) => invoke<Record<string, KeyStatus>>("ai_key_status", { presets }),
  keySet: (preset: string, key: string) => invoke<KeyStatus>("ai_key_set", { preset, key }),
  keyClear: (preset: string) => invoke<void>("ai_key_clear", { preset }),
  pullStart: (model: string) => invoke<void>("ai_pull_start", { model }),
  pullCancel: () => invoke<boolean>("ai_pull_cancel"),
  ollamaInstalled: () => invoke<boolean>("ollama_installed"),
  ollamaInstall: () => invoke<void>("ollama_install"),
  ollamaLaunch: () => invoke<void>("ollama_launch"),
};

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/** Same rule as the engine's validateModelTag (the engine re-checks before pulling). */
export function isValidModelTag(tag: string): boolean {
  const t = tag.trim();
  return t.length > 0 && t.length <= 200 && TAG.test(t);
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
