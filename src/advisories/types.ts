export type Role =
  | "director"
  | "orchestrator"
  | "worker"
  | "research"
  | "plan"
  | "verify"
  | "execute"
  | "reviewer";

/** One shape for advisories and safety rejections. */
export interface Notice {
  level: "advisory" | "rejection";
  rule: string;
  what: string;
  why: string;
  alternative: string;
}

/** Who a notice is for. Holds no call, turn, token, context, or generation count. */
export interface Subject {
  id: string;
  taskId: string | null;
  runId: string | null;
  role: Role;
  readOnly: boolean;
  brief: { text: string; pathHints: string[] };
  writeScopes: string[];
  writableExtraRoots: string[];
  workspaceRoot: string;
}

/** Structural copy of the runner tool event. */
export interface ToolEventLike {
  id?: string;
  name: string;
  status: string;
  kind?: string;
  title?: string;
  args?: string;
  result?: string;
  error?: string;
  via?: "code_exec";
  paths?: string[];
  denied?: string;
}

export interface ObservedCall {
  origin: "event" | "result";
  surface: "native" | "harness";
  tool: string;
  nativeClass?: "read" | "search" | "edit" | "shell" | "fetch" | "other";
  status: "completed" | "failed";
  id?: string;
  args: Record<string, unknown> | undefined;
  paths: string[];
  result?: unknown;
  inScript: boolean;
  denied?: string;
}

export interface Finding {
  key?: string;
  what: string;
  why: string;
  alternative: string;
  data?: unknown;
}

export interface RuleContext {
  /** The subject's scope source for this generation, or null when the role has none. */
  scope: ScopeSignalSource | null;
  filesOutsideWriteScopes(files: string[], writeScopes: string[]): string[];
}

export interface AdvisoryRule<S = unknown> {
  id: string;
  roles: readonly Role[];
  surface: "event" | "result";
  priority: number;
  init(subject: Subject): S;
  /** Update state from one call. Return a finding while the signal holds. */
  observe(state: S, subject: Subject, call: ObservedCall, ctx: RuleContext): Finding | null;
  dedupe: {
    perKey: "subject" | "generation";
    maxPerSubject?: number;
    maxPerGeneration?: number;
    /** May the same key fire again in this generation? Called with the state as it is now. */
    rearm?(state: S, ctx: RuleContext): boolean;
  };
  /** Called when the engine accepted a finding, so the rule can snapshot state for rearm. */
  fired?(state: S, ctx: RuleContext): void;
}

/** goal-13's signals behind an interface. Thresholds and the fire decision live in the implementation. */
export interface ScopeSignalSource {
  observe(call: {
    id?: string;
    name: string;
    kind?: string;
    status: "in_progress" | "completed" | "failed";
    args?: string | Record<string, unknown>;
  }): void;
  /** The fire decision with structured reasons and no cadence. */
  evaluate(): ScopeFinding | null;
  signals(): {
    distinctAreas: string[];
    newAreasInWindow: number;
    searchTopics: string[];
    repeatStreak: number;
    staleStreak: number;
  };
  /** Marks of the source's own signal-bearing calls. Read only by the rule's rearm after a first notice fired. */
  marks(): { areas: number; scoredCalls: number };
  resetStale(): void;
}

export interface ScopeFinding {
  widening?: { areas: string[]; topics: string[] };
  repeated?: { tool: string; times: number };
  stale?: { reads: number };
}

export type Delivery = "tool_result" | "steer" | "dropped";

export interface AdvisoryRecord {
  subject: Subject;
  notice: Notice;
  key: string;
  delivery: Delivery;
  data?: unknown;
}
