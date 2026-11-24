import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { NativeEventParser } from "./native.js";
import { deniedNotice } from "./rejections.js";
import type {
  AdvisoryRecord,
  AdvisoryRule,
  Notice,
  ObservedCall,
  RuleContext,
  ScopeSignalSource,
  Subject,
  ToolEventLike,
} from "./types.js";

export interface EngineDeps {
  rules: readonly AdvisoryRule[];
  /** One source per subject and generation. Return null for roles without the scope rule. */
  createScopeSource(subject: Subject): ScopeSignalSource | null;
  filesOutsideWriteScopes(files: string[], writeScopes: string[]): string[];
  /** Every harness tool name plus "code_exec" and "tool_search"; the parser uses it to tell harness events from native ones. */
  harnessToolNames: ReadonlySet<string>;
  /** Writes one agent.advisory event: { rule, key, level, what, why, alternative, delivery, data }. */
  record(entry: AdvisoryRecord): void;
  /** Fired (rule, key) pairs from earlier agent.advisory events. Called once per subject, on first sight. */
  firedBefore?(subject: Subject): Array<{ rule: string; key: string }>;
}

const MAX_DENIALS_PER_GENERATION = 3;
const REJECTION_PRIORITY = 110;
const POSTED_PRIORITY = 90;

interface PendingItem {
  subject: Subject;
  notice: Notice;
  key: string;
  priority: number;
  seq: number;
  lifetime: "generation" | "subject";
  generation: number;
  data?: unknown;
}

interface SubjectState {
  subject: Subject;
  generation: number;
  parser: NativeEventParser | null;
  scope: ScopeSignalSource | null;
  ruleStates: Map<string, unknown>;
  firedSubjectKeys: Set<string>;
  firedSubjectCounts: Map<string, number>;
  firedGenKeys: Set<string>;
  firedGenCounts: Map<string, number>;
  deniedGenKeys: Set<string>;
  deniedGenCount: number;
  pending: PendingItem[];
  activityPaths: Set<string>;
  otherDossierReads: Set<string>;
  verificationEvidence: Set<string>;
}

function compositeKey(rule: string, key: string): string {
  return `${rule}\0${key}`;
}

function hasParentTraversalComponent(p: string): boolean {
  return p.replaceAll("\\", "/").split("/").includes("..");
}

function shellCommandKey(name: string, args: Record<string, unknown> | undefined): string {
  if (args) {
    for (const key of ["command", "cmd", "script"] as const) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    if (Array.isArray(args.argv) && args.argv.length > 0) {
      const joined = args.argv.map((item) => String(item)).join(" ").trim();
      if (joined) return joined;
    }
  }
  return name.trim();
}

export class AdvisoryEngine {
  private readonly deps: EngineDeps;
  private readonly rulesById: Map<string, AdvisoryRule>;
  private readonly subjects = new Map<string, SubjectState>();
  private readonly noticeMeta = new WeakMap<Notice, PendingItem>();
  private seq = 0;

  constructor(deps: EngineDeps) {
    this.deps = {
      ...deps,
      rules: [...deps.rules],
    };
    this.rulesById = new Map(this.deps.rules.map((r) => [r.id, r]));
  }

  private ensureSubject(subject: Subject): SubjectState {
    const existing = this.subjects.get(subject.id);
    if (existing) {
      if (existing.subject.workspaceRoot !== subject.workspaceRoot && existing.parser) {
        existing.parser = new NativeEventParser({
          workspaceRoot: subject.workspaceRoot,
          harnessToolNames: this.deps.harnessToolNames,
        });
      }
      existing.subject = subject;
      return existing;
    }

    const firedSubjectKeys = new Set<string>();
    const firedSubjectCounts = new Map<string, number>();
    const prior = this.deps.firedBefore?.(subject) ?? [];
    for (const item of prior) {
      const rule = this.rulesById.get(item.rule);
      if (!rule || rule.dedupe.perKey !== "subject") continue;
      const ck = compositeKey(item.rule, item.key);
      if (!firedSubjectKeys.has(ck)) {
        firedSubjectKeys.add(ck);
        firedSubjectCounts.set(item.rule, (firedSubjectCounts.get(item.rule) ?? 0) + 1);
      }
    }

    const created: SubjectState = {
      subject,
      generation: 0,
      parser: null,
      scope: null,
      ruleStates: new Map(),
      firedSubjectKeys,
      firedSubjectCounts,
      firedGenKeys: new Set(),
      firedGenCounts: new Map(),
      deniedGenKeys: new Set(),
      deniedGenCount: 0,
      pending: [],
      activityPaths: new Set(),
      otherDossierReads: new Set(),
      verificationEvidence: new Set(),
    };
    this.subjects.set(subject.id, created);
    return created;
  }

  private ensureGeneration(st: SubjectState): void {
    if (!st.parser) {
      st.parser = new NativeEventParser({
        workspaceRoot: st.subject.workspaceRoot,
        harnessToolNames: this.deps.harnessToolNames,
      });
      st.scope = this.deps.createScopeSource(st.subject);
    }
  }

  private addWorkspaceActivityPaths(st: SubjectState, paths: readonly string[]): void {
    const absRoot = resolve(st.subject.workspaceRoot);
    for (const raw of paths) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "." || trimmed === "~" || trimmed.startsWith("~/")) continue;
      const slashPath = trimmed.replaceAll("\\", "/");
      const absPath = isAbsolute(slashPath) ? resolve(slashPath) : resolve(absRoot, slashPath);
      const rel = relative(absRoot, absPath).replaceAll("\\", "/");
      if (!rel || rel === "." || hasParentTraversalComponent(rel) || isAbsolute(rel)) continue;
      if (rel === ".harness" || rel.startsWith(".harness/")) continue;
      st.activityPaths.add(rel);
    }
  }

  private enqueue(st: SubjectState, item: PendingItem): void {
    this.noticeMeta.set(item.notice, item);
    st.pending.push(item);
  }

  private evaluateRules(st: SubjectState, surface: "event" | "result", call: ObservedCall): void {
    const ctx: RuleContext = {
      scope: st.scope,
      filesOutsideWriteScopes: this.deps.filesOutsideWriteScopes,
    };

    for (const rule of this.deps.rules) {
      if (rule.surface !== surface) continue;
      if (!rule.roles.includes(st.subject.role)) continue;

      let ruleState: unknown;
      if (st.ruleStates.has(rule.id)) {
        ruleState = st.ruleStates.get(rule.id);
      } else {
        ruleState = rule.init(st.subject);
        st.ruleStates.set(rule.id, ruleState);
      }

      const finding = rule.observe(ruleState, st.subject, call, ctx);
      if (!finding) continue;

      const key = finding.key ?? rule.id;
      const ck = compositeKey(rule.id, key);
      const subjectCount = st.firedSubjectCounts.get(rule.id) ?? 0;
      const genCount = st.firedGenCounts.get(rule.id) ?? 0;

      if (rule.dedupe.maxPerSubject !== undefined && subjectCount >= rule.dedupe.maxPerSubject) {
        continue;
      }
      if (rule.dedupe.maxPerGeneration !== undefined && genCount >= rule.dedupe.maxPerGeneration) {
        continue;
      }

      const alreadyFired =
        rule.dedupe.perKey === "subject" ? st.firedSubjectKeys.has(ck) : st.firedGenKeys.has(ck);
      if (alreadyFired && rule.dedupe.rearm?.(ruleState, ctx) !== true) {
        continue;
      }

      st.firedSubjectKeys.add(ck);
      st.firedSubjectCounts.set(rule.id, subjectCount + 1);
      st.firedGenKeys.add(ck);
      st.firedGenCounts.set(rule.id, genCount + 1);
      rule.fired?.(ruleState, ctx);

      const notice: Notice = {
        level: "advisory",
        rule: rule.id,
        what: finding.what,
        why: finding.why,
        alternative: finding.alternative,
      };
      this.enqueue(st, {
        subject: st.subject,
        notice,
        key,
        priority: rule.priority,
        seq: ++this.seq,
        lifetime: rule.dedupe.perKey,
        generation: st.generation,
        data: finding.data,
      });
    }
  }

  /**
   * A runner or Code Mode tool event. Merges updates by call id, feeds the scope source,
   * evaluates event-surface rules, turns a runner denial into a rejection notice,
   * and records activity paths. Returns true when a notice is pending.
   */
  observeEvent(subject: Subject, ev: ToolEventLike): boolean {
    const st = this.ensureSubject(subject);
    this.ensureGeneration(st);

    const merged = st.parser!.push(ev);
    if (merged === null) {
      if (ev.status === "pending" || ev.status === "in_progress") {
        st.scope?.observe({
          id: ev.id,
          name: ev.name,
          kind: ev.kind,
          status: "in_progress",
          args: ev.args,
        });
      }
      return st.pending.length > 0;
    }

    st.scope?.observe({
      id: merged.id,
      name: merged.name,
      kind: merged.kind,
      status: merged.status,
      args: merged.args ?? ev.args,
    });

    if (merged.denied) {
      const notice = deniedNotice(
        { denied: merged.denied, name: merged.name, args: merged.args, paths: merged.paths },
        { workspaceRoot: subject.workspaceRoot },
      );
      const target = merged.paths[0] ?? merged.name;
      const key = `${notice.rule}:${target}`;
      const ck = compositeKey(notice.rule, key);
      if (st.deniedGenCount < MAX_DENIALS_PER_GENERATION && !st.deniedGenKeys.has(ck)) {
        st.deniedGenKeys.add(ck);
        st.deniedGenCount += 1;
        this.enqueue(st, {
          subject: st.subject,
          notice,
          key,
          priority: REJECTION_PRIORITY,
          seq: ++this.seq,
          lifetime: "generation",
          generation: st.generation,
          data: { denied: merged.denied, tool: merged.name, paths: merged.paths },
        });
      }
    }

    if (
      merged.status === "completed" &&
      merged.harnessTool === null &&
      !merged.viaCodeExec &&
      (merged.nativeClass === "read" || merged.nativeClass === "search" || merged.nativeClass === "edit")
    ) {
      this.addWorkspaceActivityPaths(st, merged.paths);
    }

    if (
      merged.harnessTool === null &&
      !merged.viaCodeExec &&
      merged.nativeClass === "shell" &&
      !merged.denied
    ) {
      const rawOutput = merged.status === "failed" ? (ev.error ?? ev.result) : (ev.result ?? ev.error);
      if (typeof rawOutput === "string") {
        const cmd = shellCommandKey(merged.name, merged.args);
        this.recordVerification(st, `shell:${cmd}`, `${merged.status}\0${rawOutput}`);
      }
    }

    const isHarnessEvent = merged.harnessTool !== null || merged.viaCodeExec;
    const observed: ObservedCall = {
      origin: "event",
      surface: isHarnessEvent ? "harness" : "native",
      tool: merged.harnessTool ?? merged.name,
      ...(isHarnessEvent ? {} : { nativeClass: merged.nativeClass }),
      status: merged.status,
      ...(merged.id !== undefined ? { id: merged.id } : {}),
      args: merged.args,
      paths: merged.paths,
      ...(ev.result !== undefined ? { result: ev.result } : {}),
      inScript: merged.viaCodeExec,
      ...(merged.denied !== undefined ? { denied: merged.denied } : {}),
    };

    this.evaluateRules(st, "event", observed);
    return st.pending.length > 0;
  }

  /**
   * A harness or Director tool call finished. Rules evaluate and update their state for every call,
   * including calls with `inScript` true or `status` `"failed"`. For such a call the method returns `[]`
   * and leaves every finding queued for the outer or next top-level result. For any other call it returns
   * every pending notice, highest priority first, and removes them from the queue.
   */
  observeHarness(subject: Subject, call: ObservedCall): Notice[] {
    const st = this.ensureSubject(subject);
    this.ensureGeneration(st);

    this.evaluateRules(st, "result", call);

    if (call.inScript || call.status === "failed") {
      return [];
    }
    return this.take(subject.id);
  }

  /** Queue a notice that no rule produced: the context warning for a runner without steering. */
  post(subject: Subject, notice: Notice, opts: { key: string; lifetime: "generation" | "subject" }): void {
    const st = this.ensureSubject(subject);
    const existingIdx = st.pending.findIndex((p) => p.notice.rule === notice.rule && p.key === opts.key);
    const item: PendingItem = {
      subject: st.subject,
      notice,
      key: opts.key,
      priority: notice.level === "rejection" ? REJECTION_PRIORITY : POSTED_PRIORITY,
      seq: ++this.seq,
      lifetime: opts.lifetime,
      generation: st.generation,
    };
    this.noticeMeta.set(notice, item);
    if (existingIdx !== -1) {
      st.pending[existingIdx] = item;
    } else {
      st.pending.push(item);
    }
  }

  /** Pending notices for a live steer, highest priority first. Removes them from the queue. */
  take(subjectId: string): Notice[] {
    const st = this.subjects.get(subjectId);
    if (!st || st.pending.length === 0) return [];
    const sorted = [...st.pending].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    st.pending = [];
    return sorted.map((item) => item.notice);
  }

  /** Put back, at the front, notices that a failed steer or a non-annotatable result did not deliver. */
  requeue(subjectId: string, notices: Notice[]): void {
    if (notices.length === 0) return;
    const st = this.subjects.get(subjectId);
    if (!st) {
      for (const notice of notices) {
        const meta = this.noticeMeta.get(notice);
        if (!meta) continue;
        this.deps.record({
          subject: meta.subject,
          notice,
          key: meta.key,
          delivery: "dropped",
          ...(meta.data !== undefined ? { data: meta.data } : {}),
        });
      }
      return;
    }
    const restored: PendingItem[] = [];
    for (const notice of notices) {
      const meta = this.noticeMeta.get(notice);
      if (meta) {
        if (meta.lifetime === "generation" && meta.generation !== st.generation) {
          this.deps.record({
            subject: st.subject,
            notice,
            key: meta.key,
            delivery: "dropped",
            ...(meta.data !== undefined ? { data: meta.data } : {}),
          });
          continue;
        }
        restored.push(meta);
        continue;
      }
      const fallback: PendingItem = {
        subject: st.subject,
        notice,
        key: notice.rule,
        priority: 0,
        seq: ++this.seq,
        lifetime: "subject",
        generation: st.generation,
      };
      this.noticeMeta.set(notice, fallback);
      restored.push(fallback);
    }
    if (restored.length > 0) {
      st.pending = [...restored, ...st.pending];
    }
  }

  /** Mark notices delivered. Writes the events. */
  delivered(subjectId: string, notices: Notice[], how: "tool_result" | "steer"): void {
    if (notices.length === 0) return;
    const st = this.subjects.get(subjectId);
    if (!st) return;
    for (const notice of notices) {
      const meta = this.noticeMeta.get(notice);
      this.deps.record({
        subject: st.subject,
        notice,
        key: meta?.key ?? notice.rule,
        delivery: how,
        ...(meta?.data !== undefined ? { data: meta.data } : {}),
      });
    }
  }

  private recordVerification(st: SubjectState, commandKey: string, outcome: string): void {
    const trimmed = commandKey.trim();
    if (!trimmed) return;
    const digest = createHash("sha256")
      .update(trimmed)
      .update("\0")
      .update(outcome)
      .digest("hex")
      .slice(0, 16);
    st.verificationEvidence.add(digest);
  }

  /**
   * Workspace paths the executor saw a harness tool read: `inspect_command` operands that exist,
   * and the path of an `artifact_read` of a workspace file.
   */
  noteActivity(subjectId: string, paths: string[]): void {
    const st = this.subjects.get(subjectId);
    if (!st) return;
    this.addWorkspaceActivityPaths(st, paths);
  }

  /**
   * Canonical key of a distinct indexed dossier belonging to another task in this run read via `artifact_read`.
   */
  noteDossierRead(subjectId: string, dossierKey: string): void {
    const st = this.subjects.get(subjectId);
    if (!st) return;
    const normalized = dossierKey.replaceAll("\\", "/").trim();
    if (!normalized) return;
    st.otherDossierReads.add(normalized);
  }

  /**
   * Records a distinct verification command outcome (command identity + normalized result output).
   * Identical repeated command outputs deduplicate; new outputs advance `verificationProgress`.
   */
  noteVerification(subjectId: string, commandKey: string, outcome: string): void {
    const st = this.subjects.get(subjectId);
    if (!st) return;
    this.recordVerification(st, commandKey, outcome);
  }

  /**
   * Number of distinct workspace paths read/searched/edited plus distinct other-task dossiers read in all generations.
   * Compared for equality between two rollovers by the L3 fingerprint. Never compared with a threshold.
   */
  activityProgress(subjectId: string): number {
    const st = this.subjects.get(subjectId);
    if (!st) return 0;
    return st.activityPaths.size + st.otherDossierReads.size;
  }

  /**
   * Number of distinct verification command outcomes observed across all generations.
   * Compared for equality between two rollovers by the L3 fingerprint. Never compared with a threshold.
   */
  verificationProgress(subjectId: string): number {
    return this.subjects.get(subjectId)?.verificationEvidence.size ?? 0;
  }

  /**
   * A generation ended. Per-generation state resets: rule states, parser, scope source,
   * generation-lifetime notices (recorded as dropped).
   * The fired set, the activity set, and subject-lifetime notices stay.
   */
  generationEnded(subjectId: string): void {
    const st = this.subjects.get(subjectId);
    if (!st) return;

    const kept: PendingItem[] = [];
    for (const item of st.pending) {
      if (item.lifetime === "generation") {
        this.deps.record({
          subject: st.subject,
          notice: item.notice,
          key: item.key,
          delivery: "dropped",
          ...(item.data !== undefined ? { data: item.data } : {}),
        });
      } else {
        kept.push(item);
      }
    }
    st.pending = kept;
    st.generation += 1;
    st.ruleStates.clear();
    st.firedGenKeys.clear();
    st.firedGenCounts.clear();
    st.deniedGenKeys.clear();
    st.deniedGenCount = 0;
    st.parser = null;
    st.scope = null;
  }

  /** The subject settled. Each pending notice is recorded with delivery "dropped". All state is freed. */
  settle(subjectId: string): void {
    const st = this.subjects.get(subjectId);
    if (!st) return;
    for (const item of st.pending) {
      this.deps.record({
        subject: st.subject,
        notice: item.notice,
        key: item.key,
        delivery: "dropped",
        ...(item.data !== undefined ? { data: item.data } : {}),
      });
    }
    this.subjects.delete(subjectId);
  }
}
