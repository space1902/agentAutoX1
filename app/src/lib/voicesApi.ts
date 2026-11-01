// Typed wrappers for the "Voces" section (ElevenLabs). The key is stored in the Windows Credential Manager by the
// backend; the UI can set it, clear it and see a masked tail, but never read it back.
import { invoke } from "@tauri-apps/api/core";

export interface VoiceKeyStatus {
  present: boolean;
  masked: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  labels: Record<string, string>;
  previewUrl: string | null;
}

export interface Subscription {
  tier: string;
  status: string;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number | null;
}

export interface VoicePreset {
  id: string;
  name: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarity: number;
  style: number;
  speakerBoost: boolean;
  product: string;
  country: string;
  note: string;
}

export interface VoiceProduct {
  name: string;
  folder: string;
  countries: string[];
}

export interface VoiceContext {
  root: string;
  products: VoiceProduct[];
  models: string[];
  defaultModel: string;
  maxChars: number;
}

export interface Estimate {
  chars: number;
  credits: number;
  modelId: string;
}

export interface GenerateRequest {
  text: string;
  presetId?: string;
  voiceId?: string;
  modelId?: string;
  product?: string;
  country?: string;
  filename?: string;
  outputDir?: string;
  confirmed: boolean;
  confirmedCredits: number;
}

const call = <T,>(command: string, payload: Record<string, unknown> = {}) => invoke<T>("voices_call", { command, payload });

export const voicesApi = {
  keyStatus: () => invoke<VoiceKeyStatus>("voices_key_status"),
  keySet: (key: string) => invoke<VoiceKeyStatus>("voices_key_set", { key }),
  keyClear: () => invoke<void>("voices_key_clear"),
  context: () => call<VoiceContext>("context"),
  testKey: () => call<{ ok: boolean; tier: string; remaining: number; limit: number }>("key-test"),
  voices: () => call<{ voices: VoiceInfo[] }>("voices"),
  subscription: () => call<{ subscription: Subscription }>("subscription"),
  presets: () => call<{ presets: VoicePreset[] }>("presets-get"),
  savePresets: (presets: Array<Partial<VoicePreset>>) => call<{ presets: VoicePreset[] }>("presets-set", { presets }),
  estimate: (text: string, presetId?: string, modelId?: string) => call<Estimate>("estimate", { text, presetId, modelId }),
  generate: (req: GenerateRequest) => call<{ file: string; chars: number; credits: number; preset: string | null }>("generate", { ...req }),
  audio: (path: string) => call<{ dataUrl: string }>("audio-read", { path }),
};

export const formatNumber = (n: number) => n.toLocaleString("es-CO");
