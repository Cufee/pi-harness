import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HarnessConfig } from "../config.js";
import type { ControlPlaneDb, TaskRecord } from "../control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../control-plane/tools.js";
import type { AdvisoryEngine } from "./engine.js";
import { attachNotices } from "./message.js";
import { roleOf } from "./roles.js";
import type { Subject } from "./types.js";

const MAX_INSPECT_OPERANDS = 16;

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

  override async execute(
    runId: string,
    taskId: string,
    name: string,
    args: Record<string, unknown>,
    scriptSignal?: AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const task = this.advDb.getTask(taskId);
    if (!task || task.runId !== runId) {
      return super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    }

    const role = roleOf(task);
    if (role === "director" || role === "reviewer") {
      return super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    }

    const subject = this.adv.subjectFor(task);
    if (!subject) {
      return super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    }

    if (name === "__list_tools" || name === "tool_search") {
      return super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    }

    if (name === "code_exec") {
      const result = await super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
      if (scriptSignal === undefined) {
        const notices = this.adv.engine.take(subject.id);
        if (notices.length > 0) {
          const { result: annotated, attached } = attachNotices(result, notices);
          if (attached) {
            this.adv.engine.delivered(subject.id, notices, "tool_result");
            return annotated;
          }
          this.adv.engine.requeue(subject.id, notices);
        }
      }
      return result;
    }

    const inScript = scriptSignal !== undefined;
    let result: unknown;
    try {
      result = await super.execute(runId, taskId, name, args, scriptSignal, callerSignal);
    } catch (err) {
      this.adv.engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: name,
        status: "failed",
        args,
        paths: [],
        inScript,
      });
      throw err;
    }

    const notices = this.adv.engine.observeHarness(subject, {
      origin: "result",
      surface: "harness",
      tool: name,
      status: "completed",
      args,
      paths: [],
      result,
      inScript,
    });

    if (name === "inspect_command") {
      const workspaceRoot = this.adv.workspaceRootFor?.(task) ?? subject.workspaceRoot;
      const paths = extractInspectCommandPaths(args, workspaceRoot);
      if (paths.length > 0) {
        this.adv.engine.noteActivity(subject.id, paths);
      }
    } else if (name === "artifact_read") {
      const workspaceRoot = this.adv.workspaceRootFor?.(task) ?? subject.workspaceRoot;
      const paths = extractArtifactReadPaths(args, workspaceRoot);
      if (paths.length > 0) {
        this.adv.engine.noteActivity(subject.id, paths);
      }
    }

    if (!inScript && notices.length > 0) {
      const { result: annotated, attached } = attachNotices(result, notices);
      if (attached) {
        this.adv.engine.delivered(subject.id, notices, "tool_result");
        return annotated;
      }
      this.adv.engine.requeue(subject.id, notices);
    }

    return result;
  }
}
