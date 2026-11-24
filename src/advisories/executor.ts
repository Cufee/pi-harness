import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HarnessConfig } from "../config.js";
import type { ControlPlaneDb, TaskRecord } from "../control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../control-plane/tools.js";
import type { AdvisoryEngine } from "./engine.js";
import { attachNotices } from "./message.js";
import { roleOf } from "./roles.js";
import type { Notice, Subject } from "./types.js";

const MAX_INSPECT_OPERANDS = 16;

function isCodeExecFailureResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).ok === false
  );
}

function logAdvisoryError(phase: string, err: unknown, runId: string, taskId: string, tool: string): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[advisories] fail-open error in ${phase} (run=${runId} task=${taskId} tool=${tool}): ${msg}`);
  } catch {
    // Logging must never break fail-open tool execution.
  }
}

export interface AdvisedExecutorOptions {
  engine: AdvisoryEngine;
  subjectFor(task: TaskRecord): Subject | null;
  workspaceRootFor?(task: TaskRecord): string | null;
}

function extractInspectCommandPaths(args: Record<string, unknown>, workspaceRoot: string): string[] {
  if (!Array.isArray(args.argv) || args.argv.length <= 1) return [];
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    realRoot = resolve(workspaceRoot);
  }
  const cwdArg = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : ".";
  const baseDir = resolve(realRoot, cwdArg);

  const out: string[] = [];
  const seen = new Set<string>();
  let checked = 0;

  for (let i = 1; i < args.argv.length && checked < MAX_INSPECT_OPERANDS; i++) {
    const operand = args.argv[i];
    if (typeof operand !== "string") continue;
    const trimmed = operand.trim();
    if (!trimmed || trimmed.startsWith("-")) continue;
    checked += 1;

    const candidate = resolve(baseDir, trimmed);
    if (!existsSync(candidate)) continue;
    let realCandidate: string;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      realCandidate = candidate;
    }
    const rel = relative(realRoot, realCandidate).replaceAll("\\", "/");
    if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    if (rel === ".harness" || rel.startsWith(".harness/")) continue;
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

function extractArtifactReadPaths(args: Record<string, unknown>, workspaceRoot: string): string[] {
  if (typeof args.path !== "string") return [];
  const trimmed = args.path.trim();
  if (!trimmed) return [];

  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    realRoot = resolve(workspaceRoot);
  }

  const candidate = resolve(realRoot, trimmed);
  if (!existsSync(candidate)) return [];
  try {
    if (!statSync(candidate).isFile()) return [];
  } catch {
    return [];
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    realCandidate = candidate;
  }

  const rel = relative(realRoot, realCandidate).replaceAll("\\", "/");
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return [];
  if (rel === ".harness" || rel.startsWith(".harness/")) return [];
  return [rel];
}

export class AdvisedToolExecutor extends ControlPlaneToolExecutor {
  private readonly advDb: ControlPlaneDb;
  private readonly adv: AdvisedExecutorOptions;

  constructor(
    db: ControlPlaneDb,
    getCatalogCompiler: ConstructorParameters<typeof ControlPlaneToolExecutor>[1],
    hooks: ToolRuntimeHooks,
    config: HarnessConfig,
    adv: AdvisedExecutorOptions,
  ) {
    super(db, getCatalogCompiler, hooks, config);
    this.advDb = db;
    this.adv = adv;
  }

  private deliverNotices(
    subjectId: string,
    notices: Notice[],
    result: unknown,
    runId: string,
    taskId: string,
    name: string,
  ): unknown {
    if (notices.length === 0) return result;
    let attached = false;
    let annotated: unknown = result;
    try {
      const out = attachNotices(result, notices);
      attached = out.attached;
      annotated = out.result;
    } catch (err) {
      logAdvisoryError("attach_notices", err, runId, taskId, name);
      try {
        this.adv.engine.requeue(subjectId, notices);
      } catch (reqErr) {
        logAdvisoryError("requeue", reqErr, runId, taskId, name);
      }
      return result;
    }

    if (attached) {
      try {
        this.adv.engine.delivered(subjectId, notices, "tool_result");
      } catch (err) {
        logAdvisoryError("record_delivery", err, runId, taskId, name);
      }
      return annotated;
    }

    try {
      this.adv.engine.requeue(subjectId, notices);
    } catch (err) {
      logAdvisoryError("requeue", err, runId, taskId, name);
    }
    return result;
  }

  override async execute(
    runId: string,
    taskId: string,
    name: string,
    args: Record<string, unknown>,
    scriptSignal?: AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    let task: TaskRecord | null = null;
    let subject: Subject | null = null;
    try {
      const found = this.advDb.getTask(taskId);
      if (found && found.runId === runId) {
        const role = roleOf(found);
        if (role !== "director" && role !== "reviewer") {
          task = found;
          subject = this.adv.subjectFor(found);
        }
      }
    } catch (err) {
      logAdvisoryError("subject_lookup", err, runId, taskId, name);
      task = null;
      subject = null;
    }

    if (!task || !subject || name === "__list_tools" || name === "tool_search") {
      return super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    }

    if (name === "code_exec") {
      const result = await super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
      if (scriptSignal === undefined && !isCodeExecFailureResult(result)) {
        let notices: Notice[] = [];
        try {
          notices = this.adv.engine.take(subject.id);
        } catch (err) {
          logAdvisoryError("take", err, runId, taskId, name);
          return result;
        }
        return this.deliverNotices(subject.id, notices, result, runId, taskId, name);
      }
      return result;
    }

    const inScript = scriptSignal !== undefined;
    let result: unknown;
    try {
      result = await super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    } catch (err) {
      try {
        this.adv.engine.observeHarness(subject, {
          origin: "result",
          surface: "harness",
          tool: name,
          status: "failed",
          args,
          paths: [],
          inScript,
        });
      } catch (advErr) {
        logAdvisoryError("observe_failed", advErr, runId, taskId, name);
      }
      throw err;
    }

    let notices: Notice[] = [];
    try {
      notices = this.adv.engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: name,
        status: "completed",
        args,
        paths: [],
        result,
        inScript,
      });
    } catch (err) {
      logAdvisoryError("observe_completed", err, runId, taskId, name);
    }

    if (name === "inspect_command" || name === "artifact_read") {
      try {
        const workspaceRoot = this.adv.workspaceRootFor?.(task) ?? subject.workspaceRoot;
        const paths =
          name === "inspect_command"
            ? extractInspectCommandPaths(args, workspaceRoot)
            : extractArtifactReadPaths(args, workspaceRoot);
        if (paths.length > 0) {
          this.adv.engine.noteActivity(subject.id, paths);
        }
      } catch (err) {
        logAdvisoryError("note_activity", err, runId, taskId, name);
      }
    }

    if (!inScript && notices.length > 0) {
      return this.deliverNotices(subject.id, notices, result, runId, taskId, name);
    }

    return result;
  }
}
