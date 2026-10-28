// Typed wrappers over the Tauri commands defined in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export interface Pod {
  name: string;
  instanceId: string;
  state: "running" | "stopped";
  serial: string | null;
  adbPort: number;
  phone: string | null;
}

export interface Settings {
  dataDir: string;
  warmupDir: string;
  podsDir: string;
  apkDir: string;
  podsWspFile: string;
  nodePath: string;
}

export interface Tester {
  id: string;
  phone: string | null;
  hasSession: boolean;
}

export interface Profile {
  name: string;
  testers: string[];
  groupName: string | null;
  createdAt: string | null;
}

export interface WarmupData {
  profiles: Profile[];
  testers: Tester[];
  defaultGroup: string | null;
}

export interface LogLine {
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface WarmupStatus {
  running: boolean;
  profile: string | null;
  pid: number | null;
  logs: LogLine[];
}

/** Tauri rejects with a plain string; normalize anything else. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Error desconocido";
}

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  getDefaultSettings: () => invoke<Settings>("get_default_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  listPods: () => invoke<Pod[]>("list_pods"),
  podAction: (action: "prender" | "apagar" | "ver", name: string) =>
    invoke<string>("pod_action", { action, name }),
  readWarmupData: () => invoke<WarmupData>("read_warmup_data"),
  readPodsWsp: () => invoke<Record<string, string>>("read_pods_wsp"),
  warmupStatus: () => invoke<WarmupStatus>("warmup_status"),
  startProfile: (name: string) => invoke<WarmupStatus>("start_profile", { name }),
  stopProfile: () => invoke<void>("stop_profile"),
};
