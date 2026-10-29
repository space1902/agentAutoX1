// Typed wrappers for the "Analista" section. The agent runs on the locally installed Claude Code (the user's plan);
// nothing here ever sees an API key. One-shot commands go through `analista_call`, streaming ones through
// `analista_start` and arrive as `analista-status` (chat) / `analista-eval-status` (quality evaluation) events.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AgentSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StepInfo {
  id: string;
  tool: string;
  label: string;
  ok: boolean | null;
  summary: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
}

export interface PlanInfo {
  fiveHour: number | null;
  resetsAt: number | null;
  status: string | null;
}

export interface MessageMeta {
  usage?: Usage;
  durationMs?: number;
  turns?: number;
  steps?: StepInfo[];
  /** Figures of the answer that were not found in the turn's data. */
  ungrounded?: string[];
  plan?: PlanInfo | null;
  model?: string;
  cancelled?: boolean;
  /** Learning: 1 = thumbs up, -1 = thumbs down / marked wrong. */
  rating?: 1 | -1;
}

export interface AgentMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  meta: MessageMeta;
}

export interface AnalistaSettings {
  claudePath: string;
  model: string;
  web: boolean;
  learning: boolean;
}

export interface AnalistaStatus {
  claude: { found: boolean; path: string | null };
  adsDb: boolean;
  agentDb: boolean;
  workspace: string;
  settings: AnalistaSettings;
}

/** Events of a chat turn (normalized by the engine from Claude Code's stream-json). */
export type TurnEvent =
  | { type: "turn_start"; sessionId: string; userMessageId: number }
  | { type: "init"; claudeSessionId: string | null; mcp: { name: string; status: string }[]; tools: string[] }
  | { type: "message_start" }
  | { type: "text"; delta: string }
  | { type: "step"; id: string; tool: string; label: string }
  | { type: "step_done"; id: string; tool: string; ok: boolean; summary: string }
  | { type: "plan"; status: string | null; fiveHour: number | null; resetsAt: number | null }
  | { type: "result"; ok: boolean; text: string; durationMs: number; turns: number; usage: Usage }
  | { type: "done"; sessionId: string; messageId: number; text: string; meta: MessageMeta; newCandidates?: number }
  | { type: "cancelled"; sessionId: string; messageId: number }
  | { type: "error"; sessionId: string | null; error: string };

export interface ProcStatus {
  running: boolean;
  pid: number | null;
  logs: string[];
}

const call = <T,>(command: string, payload: Record<string, unknown> = {}) => invoke<T>("analista_call", { command, payload });

export const analista = {
  call,
  status: () => call<AnalistaStatus>("status"),
  sessions: () => call<{ sessions: AgentSession[] }>("sessions"),
  newSession: () => call<{ sessionId: string }>("session-new"),
  renameSession: (sessionId: string, title: string) => call("session-rename", { sessionId, title }),
  deleteSession: (sessionId: string) => call("session-delete", { sessionId }),
  messages: (sessionId: string) => call<{ messages: AgentMessage[] }>("messages", { sessionId }),
  settings: () => call<{ settings: AnalistaSettings }>("settings-get"),
  saveSettings: (partial: Partial<AnalistaSettings>) => call<{ settings: AnalistaSettings }>("settings-set", partial),
  start: (command: "turn" | "eval-run", payload: Record<string, unknown>) => invoke<number>("analista_start", { command, payload }),
  cancel: () => invoke<void>("analista_cancel"),
  running: () => invoke<{ chat: ProcStatus; eval: ProcStatus }>("analista_status"),
  onTurn: (cb: (event: TurnEvent) => void): Promise<UnlistenFn> => listen<TurnEvent>("analista-status", (e) => cb(e.payload)),
  onExit: (cb: () => void): Promise<UnlistenFn> => listen("analista-exit", () => cb()),
};

export const STARTERS = [
  "¿Qué CT debería escalar esta semana?",
  "¿Cómo le fue a CT 07 desde la subida de presupuesto?",
  "Compara Colombia vs Venezuela este mes",
  "¿Qué anuncios debería apagar hoy?",
];

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export const formatTokens = (n: number) => n.toLocaleString("es-CO");
