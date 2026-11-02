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

export interface PairingCard {
  id: string;
  code: string;
  phone: string | null;
}

export interface WarmupStatus {
  running: boolean;
  profile: string | null;
  pid: number | null;
  logs: LogLine[];
  pairing: PairingCard[];
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
  /** Where the phone came from: the config, or the linked WhatsApp session when the config has none. */
  phoneSource: "config" | "session" | null;
  /** Other testers (or "bot") that use this same number. */
  duplicateOf: string[];
}

export interface TesterPhone {
  id: string;
  phone: string | null;
  configPhone: string | null;
  sessionPhone: string | null;
  phoneSource: "config" | "session" | null;
  linked: boolean;
  mismatch: boolean;
  duplicateOf: string[];
}

export interface DuplicateGroup {
  key: string;
  phone: string;
  /** Tester ids, plus "bot" for the main bot number. */
  members: string[];
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
  testers: Record<string, TesterPhone>;
  duplicates: DuplicateGroup[];
}

export interface ProfileTester {
  id: string;
  phone: string | null;
  phoneSource: "config" | "session" | null;
  sessionPhone: string | null;
  mismatch: boolean;
  duplicateOf: string[];
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

export type LinkStage =
  | "queued"
  | "powering-on"
  | "waiting-android"
  | "requesting-code"
  | "typing-code"
  | "waiting-link"
  | "linked"
  | "powering-off"
  | "manual"
  | "failed"
  | "cancelled"
  | "dry-run";

export interface LinkTarget {
  testerId: string;
  phone: string;
  podName: string;
}

export interface LinkProgress extends LinkTarget {
  stage: LinkStage;
  message: string;
  code: string | null;
  index: number;
  total: number;
}

export interface LinkResult {
  testerId: string;
  podName: string;
  stage: LinkStage;
  ok: boolean;
  message: string;
  code: string | null;
}

export type KeepAlivePhase = "idle" | "scanning" | "powering-on" | "holding" | "powering-off" | "waiting-exit";

export interface KeepAliveStatus {
  enabled: boolean;
  phase: KeepAlivePhase;
  current: string | null;
  /** Unix second when the pod being checked will be turned off. */
  holdUntil: number | null;
  queue: string[];
  lastRun: { pod: string; at: number; outcome: "ok" | "skipped" | "failed" | "interrupted"; note: string } | null;
  lastScanAt: number | null;
  message: string;
}

export interface EmbedState {
  attached: string[];
  active: string | null;
  /** Pods still starting: their window is not embedded yet. */
  booting: string[];
  /** Pods whose window stopped answering and was released by the watchdog. */
  hung: string[];
}

export type Light = "verde" | "amarillo" | "rojo";

export interface LineHealthPart {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface LineHealth {
  score: number;
  light: Light;
  linked: boolean;
  phase: { phase: number; name: string };
  components: LineHealthPart[];
  reasons: string[];
  severeRecent: boolean;
  stats?: { days: number; sent: number; received: number; lastActivityAt: string | null };
}

export interface LineHealthData {
  generatedAt: string;
  lines: Record<string, LineHealth>;
}

/** Result of "Reiniciar pods". */
export interface PodsResetReport {
  restarted: string[];
  /** Stopped and left off on purpose (the auto-review had turned it on). */
  leftOff: string[];
  failed: { pod: string; step: "apagar" | "prender"; error: string }[];
  message: string;
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
  resetPods: () => invoke<PodsResetReport>("reset_pods"),
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
  planPodLinks: (name: string) => invoke<LinkTarget[]>("plan_pod_links", { name }),
  runPodLinks: (name: string, dryRun: boolean, powerOffAfter: boolean) =>
    invoke<LinkResult[]>("run_pod_links", { name, dryRun, powerOffAfter }),
  cancelPodLinks: () => invoke<void>("cancel_pod_links"),
  getEmbedView: async () => Boolean(((await invoke<Settings>("get_settings")) as Settings & { embedView?: boolean }).embedView),
  setEmbedView: (enabled: boolean) => invoke<Settings>("set_embed_view", { enabled }),
  embedAttach: (name: string, serial: string | null, x: number, y: number, width: number, height: number, viewWidth: number, viewHeight: number, dpr: number) =>
    invoke<EmbedState>("embed_attach", { name, serial, x, y, width, height, viewWidth, viewHeight, dpr }),
  embedState: () => invoke<EmbedState>("embed_state"),
  embedRetry: (name: string) => invoke<EmbedState>("embed_retry", { name }),
  embedResize: (name: string, x: number, y: number, width: number, height: number, viewWidth: number, viewHeight: number, dpr: number) =>
    invoke<void>("embed_resize", { name, x, y, width, height, viewWidth, viewHeight, dpr }),
  embedActivate: (name: string | null) => invoke<EmbedState>("embed_activate", { name }),
  embedDetach: (name: string) => invoke<EmbedState>("embed_detach", { name }),
  keepAliveStatus: () => invoke<KeepAliveStatus>("keepalive_status"),
  setKeepAlive: (enabled: boolean) => invoke<KeepAliveStatus>("set_keep_alive", { enabled }),
  lineHealth: () => invoke<LineHealthData>("line_health"),
  readWarmupData: () => invoke<WarmupData>("read_warmup_data"),
  readPodsWsp: () => invoke<Record<string, string>>("read_pods_wsp"),
  warmupStatus: () => invoke<WarmupStatus>("warmup_status"),
  startProfile: (name: string) => invoke<WarmupStatus>("start_profile", { name }),
  stopProfile: () => invoke<void>("stop_profile"),
};
