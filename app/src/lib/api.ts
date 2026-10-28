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

export type NumberSource = "pod" | "externo" | "pod sin calentar";

export interface RegistryRow {
  key: string;
  phone: string;
  pod: { name: string; instanceId: string; state: "running" | "stopped" } | null;
  extraPods: string[];
  testerId: string | null;
  linked: boolean;
  profiles: string[];
  groups: string[];
  source: NumberSource;
  isBot: boolean;
}

export interface TesterWithoutPhone {
  id: string;
  linked: boolean;
  profiles: string[];
  groups: string[];
}

export interface Registry {
  rows: RegistryRow[];
  podsWithoutPhone: { name: string; instanceId: string; state: string }[];
  testersWithoutPhone: TesterWithoutPhone[];
}

export interface ProfileTester {
  id: string;
  phone: string | null;
  linked: boolean;
  podName: string | null;
}

export interface ProfileView {
  name: string;
  groupName: string | null;
  effectiveGroup: string | null;
  createdAt: string | null;
  testers: ProfileTester[];
}

export interface ProfilesData {
  defaultGroup: string | null;
  botNumber: string | null;
  profiles: ProfileView[];
  registry: Registry;
}

/** Data from the engine plus a warning when the pod list could not be read. */
export interface Overview<T> {
  data: T;
  podsError: string | null;
}

/** What the engine receives for each chosen number: an existing tester, or a phone (it creates the tester). */
export type Selection = { testerId: string } | { phone: string };

export interface PodProgress {
  step: number | null;
  total: number | null;
  text: string;
  line: string;
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
  createPod: (name: string, phone: string) => invoke<string>("create_pod", { name, phone }),
  renamePod: (name: string, newName: string) => invoke<string>("rename_pod", { name, newName }),
  setPodPhone: (name: string, phone: string) => invoke<string>("set_pod_phone", { name, phone }),
  deletePod: (name: string, confirm: string) => invoke<string>("delete_pod", { name, confirm }),
  profilesOverview: () => invoke<Overview<ProfilesData>>("profiles_overview"),
  registryOverview: () => invoke<Overview<Registry>>("registry_overview"),
  profileCreate: (name: string, group: string | null, selections: Selection[]) =>
    invoke<unknown>("profile_create", { name, group, selections }),
  profileUpdate: (name: string, newName: string | null, group: string | null, selections: Selection[] | null) =>
    invoke<unknown>("profile_update", { name, newName, group, selections }),
  profileDelete: (name: string) => invoke<unknown>("profile_delete", { name }),
  readWarmupData: () => invoke<WarmupData>("read_warmup_data"),
  readPodsWsp: () => invoke<Record<string, string>>("read_pods_wsp"),
  warmupStatus: () => invoke<WarmupStatus>("warmup_status"),
  startProfile: (name: string) => invoke<WarmupStatus>("start_profile", { name }),
  stopProfile: () => invoke<void>("stop_profile"),
};
