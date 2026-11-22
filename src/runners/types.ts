import type { AgentTier, ArtifactRecord, TaskKind } from "../control-plane/db.js";
import type { ToolDisplayPayload } from "../protocol/tool-display.js";

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

export interface QuotaRetryStateEvent {
  state: "retrying" | "recovered";
  retryCount: number;
  timeoutMs: number;
  reason?: string;
  resetAt?: string | null;
}

export interface QuotaPauseInfo {
  reason: string;
  resetAt?: string | null;
  retryCount: number;
  watchdogTimedOut: boolean;
  isHardExhaustion: boolean;
}

export interface RunnerCallbacks {
  onSessionId?: (sessionId: string) => void;
  onTextDelta?: (text: string) => void;
  onThoughtDelta?: (text: string) => void;
  onUsage?: (usage: RunnerUsage) => void;
  onArtifact?: (artifact: Omit<ArtifactRecord, "id" | "runId" | "taskId" | "createdAt">) => void;
  onPassiveQuota?: (signal: PassiveQuotaSignal) => void;
  onQuotaRetryState?: (ev: QuotaRetryStateEvent) => void;
  onToolEvent?: (ev: {
    id?: string;
    name: string;
    status: string;
    kind?: string;
    title?: string;
    /** Structured rich output (contract/tool-display-v1); events without it render as a compact tool pill. */
    display?: ToolDisplayPayload;
  }) => void;
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
  /** Soft timeout (ms) allowing native 429/rate-limit retries across subscription pools before pausing early. */
  quotaRetryTimeoutMs?: number;
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
  stopReason: "completed" | "cancelled" | "rollover_requested" | "quota_paused" | "max_turns" | "error";
  usage?: RunnerUsage;
  sessionId?: string;
  quotaPause?: QuotaPauseInfo;
  toolFailures?: string[];
}

export interface ProbedModelInfo {
  wireModelId: string;
  name?: string;
  supportedEfforts?: string[];
}
