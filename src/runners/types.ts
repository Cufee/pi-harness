import type { AgentTier, ArtifactRecord, TaskKind } from "../control-plane/db.js";

export interface RunnerUsage {
  used: number;
  size: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  costUsd?: number;
}

export interface PassiveQuotaSignal {
  profileId: string;
  model?: string | null;
  raw: Record<string, unknown>;
  observedAt: number;
}

export interface RunnerCallbacks {
  onSessionId?: (sessionId: string) => void;
  onTextDelta?: (text: string) => void;
  onThoughtDelta?: (text: string) => void;
  onUsage?: (usage: RunnerUsage) => void;
  onArtifact?: (artifact: Omit<ArtifactRecord, "id" | "runId" | "taskId" | "createdAt">) => void;
  onPassiveQuota?: (signal: PassiveQuotaSignal) => void;
  onToolEvent?: (ev: { id?: string; name: string; status: string; kind?: string; title?: string }) => void;
}

export interface RunnerExecutionHandle {
  steer(message: string): Promise<boolean>;
  cancel(reason?: string): Promise<void>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RunAgentRequest {
  runId: string;
  taskId: string;
  tier: AgentTier;
  kind: TaskKind;
  cwd: string;
  readOnly: boolean;
  systemPrompt: string;
  initialPrompt: string;
  model?: string | null;
  effort?: string | null;
  maxTurns: number;
  rolloverThreshold?: number;
  /** Role-scoped harness tools exposed via in-process callback (Pi) or MCP bridge (ACP) */
  tools: ToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Daemon Unix socket path + auth token for ACP stdio MCP bridge subprocesses */
  daemonSocketPath?: string;
  mcpBridgeEntrypoint?: string;
  signal: AbortSignal;
  callbacks: RunnerCallbacks;
  onHandle?: (handle: RunnerExecutionHandle) => void;
}

export interface RunAgentResult {
  text: string;
  stopReason: "completed" | "cancelled" | "rollover_requested" | "max_turns" | "error";
  usage?: RunnerUsage;
  sessionId?: string;
}

export interface ProbedModelInfo {
  wireModelId: string;
  name?: string;
  supportedEfforts?: string[];
}
