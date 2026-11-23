import type { EventRecord } from "../control-plane/db.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import {
  formatClock,
  formatCountdown,
  formatToolLabel,
  sanitizeLine,
  type Tone,
  type ToolStatus,
  type TranscriptBlock,
} from "./core/index.js";

/**
 * Event-to-typed-block fold behind `LiveTranscriptScreen`.
 * Converts `watch.start` replay and live frames into `ModelBlock` entries backed by
 * `TranscriptBlock` values so rendering, folding, selection, and caching live in `TranscriptView`.
 */

export interface ModelBlock {
  id: number;
  /** Bumped on every mutation of this block; the view's row cache keys on it. */
  rev: number;
  open: boolean;
  taskId: string | null;
  createdAt: number;
  block: TranscriptBlock;
  /** Raw `agent.tool` payload, for Ctrl+X inspect. */
  payload?: unknown;
}

export type AgentEventFold =
  | { kind: "text" | "thought"; delta: string }
  | {
      kind: "tool";
      id?: string;
      label: string;
      status: ToolStatus;
      args?: string;
      result?: string;
      error?: string;
      legacy?: "start" | "end";
      payload: Record<string, unknown>;
    }
  | { kind: "turn_end" }
  | { kind: "notice"; tone: Tone; glyph?: "pause" | "cross"; tag: string; text: string };

const MAX_BLOCKS = 2000;
const TRIM_TO_BLOCKS = 1500;

function toolStatus(raw: string): ToolStatus {
  if (raw === "completed" || raw === "ok") return "ok";
  if (raw === "failed" || raw === "error") return "error";
  return "running";
}

function detailText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Normalizes one agent/quota event. Returns null for event types it does not own. */
export function foldAgentEvent(ev: EventRecord | DaemonEventFrame): AgentEventFold | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;

  if (ev.type === "agent.text_delta") {
    return { kind: "text", delta: String(p.text ?? p.delta ?? "") };
  }
  if (ev.type === "agent.thought_delta") {
    return { kind: "thought", delta: String(p.text ?? p.delta ?? "") };
  }
  if (ev.type === "agent.tool") {
    const id = p.id != null ? String(p.id) : p.toolCallId != null ? String(p.toolCallId) : undefined;
    const rawName = String(p.title ?? p.name ?? p.toolName ?? "tool");
    return {
      kind: "tool",
      id,
      label: formatToolLabel(rawName),
      status: toolStatus(String(p.status ?? "running")),
      args: detailText(p.args),
      result: detailText(p.result),
      error: detailText(p.error),
      payload: p,
    };
  }
  if (ev.type === "agent.tool_start" || ev.type === "agent.tool_end") {
    const rawName = String(p.toolName ?? p.name ?? p.title ?? "tool");
    return {
      kind: "tool",
      label: formatToolLabel(rawName),
      status: ev.type === "agent.tool_start" ? "running" : "ok",
      legacy: ev.type === "agent.tool_start" ? "start" : "end",
      payload: p,
    };
  }
  if (ev.type === "agent.turn_end") {
    return { kind: "turn_end" };
  }
  if (ev.type === "agent.rollover") {
    const gen = p.generation ?? p.nextGeneration ?? "";
    const reason = p.reason ? ` (${sanitizeLine(String(p.reason))})` : "";
    return {
      kind: "notice",
      tone: "info",
      tag: "rollover",
      text: `rollover${gen ? ` → gen ${gen}` : ""}${reason}`,
    };
  }
  if (ev.type === "agent.error") {
    return {
      kind: "notice",
      tone: "danger",
      glyph: "cross",
      tag: "error",
      text: sanitizeLine(String(p.message ?? p.error ?? "agent error")),
    };
  }
  if (ev.type.startsWith("quota.")) {
    const reason = sanitizeLine(String(p.reason ?? p.mode ?? ""));
    const wake = p.resumeAt ? ` · resume ${formatCountdown(p.resumeAt as number | string)}` : "";
    return {
      kind: "notice",
      tone: ev.type === "quota.run_resumed" ? "ok" : "warn",
      glyph: "pause",
      tag: ev.type.replace(/^quota\./, "quota:"),
      text: `${reason || ev.type}${wake}`,
    };
  }
  return null;
}

export class LiveTranscriptModel {
  private readonly items: ModelBlock[] = [];
  private readonly metaById = new Map<number, { taskKey: string; toolId?: string }>();
  private readonly openText = new Map<string, ModelBlock>();
  /** Whitespace-only deltas that arrived before any text; prepended to the block's first visible delta. */
  private readonly pendingLead = new Map<string, { kind: "assistant" | "thought"; text: string }>();
  private readonly toolsById = new Map<string, ModelBlock>();
  private nextId = 1;

  constructor(private readonly taskScoped: boolean) {}

  blocks(): readonly ModelBlock[] {
    return this.items;
  }

  /** Appends a failure or informational notice (e.g. `watch.start` rejection). */
  pushNotice(text: string, tone: Tone = "danger"): void {
    const now = Date.now();
    this.push(
      {
        id: this.nextId++,
        rev: 1,
        open: false,
        taskId: null,
        createdAt: now,
        block: {
          kind: "receipt",
          tone,
          text: sanitizeLine(text),
          hint: formatClock(now),
        },
      },
      "__run__",
    );
  }

  private formatMeta(taskId: string | null | undefined, createdAt: number): string {
    const clock = formatClock(createdAt);
    return !this.taskScoped && taskId ? `${taskId} · ${clock}` : clock;
  }

  private push(item: ModelBlock, taskKey: string, toolId?: string): void {
    this.items.push(item);
    this.metaById.set(item.id, { taskKey, toolId });
    if (this.items.length > MAX_BLOCKS) {
      const dropped = this.items.splice(0, this.items.length - TRIM_TO_BLOCKS);
      for (const d of dropped) {
        const meta = this.metaById.get(d.id);
        this.metaById.delete(d.id);
        if (meta?.toolId) {
          this.toolsById.delete(`${meta.taskKey}\u0000${meta.toolId}`);
        }
        if (meta && this.openText.get(meta.taskKey) === d) {
          this.openText.delete(meta.taskKey);
        }
      }
    }
  }

  private closeText(taskKey?: string): void {
    if (taskKey === undefined) {
      for (const b of this.openText.values()) {
        if (b.open) {
          b.open = false;
          b.rev += 1;
        }
      }
      this.openText.clear();
      this.pendingLead.clear();
      return;
    }
    const b = this.openText.get(taskKey);
    if (b && b.open) {
      b.open = false;
      b.rev += 1;
    }
    this.openText.delete(taskKey);
    this.pendingLead.delete(taskKey);
  }

  private appendText(
    kind: "assistant" | "thought",
    ev: EventRecord | DaemonEventFrame,
    taskKey: string,
    delta: string,
  ): void {
    let item = this.openText.get(taskKey);
    if (item && item.block.kind !== kind) {
      this.closeText(taskKey);
      item = undefined;
    }
    if (!item) {
      const lead = this.pendingLead.get(taskKey);
      if (lead && lead.kind !== kind) this.pendingLead.delete(taskKey);
      if (!delta.trim()) {
        this.pendingLead.set(taskKey, { kind, text: (lead?.kind === kind ? lead.text : "") + delta });
        return;
      }
      this.pendingLead.delete(taskKey);
      const initialText = (lead?.kind === kind ? lead.text : "") + delta;
      item = {
        id: this.nextId++,
        rev: 1,
        open: true,
        taskId: ev.taskId ?? null,
        createdAt: ev.createdAt,
        block: {
          kind,
          text: initialText,
          meta: this.formatMeta(ev.taskId, ev.createdAt),
        },
      };
      this.openText.set(taskKey, item);
      this.push(item, taskKey);
      return;
    }
    const textBlock = item.block as Extract<TranscriptBlock, { kind: "assistant" | "thought" }>;
    textBlock.text += delta;
    item.rev += 1;
  }

  ingest(ev: EventRecord | DaemonEventFrame): void {
    const taskKey = ev.taskId ?? "__run__";
    const closeKey = ev.taskId ? taskKey : undefined;
    const folded = foldAgentEvent(ev);

    if (folded === null) {
      this.closeText(closeKey);
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const summary = p.summary ?? p.status ?? p.to ?? p.title ?? p.message ?? "";
      const tag = !this.taskScoped && ev.taskId ? `${ev.taskId} · ${ev.type}` : ev.type;
      this.push(
        {
          id: this.nextId++,
          rev: 1,
          open: false,
          taskId: ev.taskId ?? null,
          createdAt: ev.createdAt,
          block: {
            kind: "receipt",
            tone: "muted",
            tag,
            text: summary ? sanitizeLine(String(summary)) : "",
            hint: formatClock(ev.createdAt),
          },
        },
        taskKey,
      );
      return;
    }

    switch (folded.kind) {
      case "text":
        this.appendText("assistant", ev, taskKey, folded.delta);
        return;

      case "thought":
        this.appendText("thought", ev, taskKey, folded.delta);
        return;

      case "turn_end":
        this.closeText(closeKey);
        return;

      case "tool": {
        if (folded.legacy) {
          this.closeText();
          if (folded.legacy === "end") {
            for (let i = this.items.length - 1; i >= 0; i--) {
              const item = this.items[i]!;
              const meta = this.metaById.get(item.id);
              if (
                item.block.kind === "tool" &&
                meta?.taskKey === taskKey &&
                item.block.label === folded.label &&
                item.block.status === "running"
              ) {
                item.block = { ...item.block, status: "ok" };
                item.open = false;
                const prevPayload =
                  item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
                    ? (item.payload as Record<string, unknown>)
                    : {};
                item.payload = { ...prevPayload, ...folded.payload };
                item.rev += 1;
                return;
              }
            }
          }
          this.push(
            {
              id: this.nextId++,
              rev: 1,
              open: folded.status === "running",
              taskId: ev.taskId ?? null,
              createdAt: ev.createdAt,
              block: {
                kind: "tool",
                label: folded.label,
                status: folded.status,
                meta: this.formatMeta(ev.taskId, ev.createdAt),
              },
              payload: folded.payload,
            },
            taskKey,
          );
          return;
        }

        this.closeText(taskKey);
        const mapKey = folded.id ? `${taskKey}\u0000${folded.id}` : undefined;
        const existing = mapKey ? this.toolsById.get(mapKey) : undefined;
        if (!existing) {
          const item: ModelBlock = {
            id: this.nextId++,
            rev: 1,
            open: folded.status === "running",
            taskId: ev.taskId ?? null,
            createdAt: ev.createdAt,
            block: {
              kind: "tool",
              label: folded.label,
              status: folded.status,
              meta: this.formatMeta(ev.taskId, ev.createdAt),
              args: folded.args,
              result: folded.result,
              error: folded.error,
            },
            payload: folded.payload,
          };
          if (mapKey) this.toolsById.set(mapKey, item);
          this.push(item, taskKey, folded.id);
          return;
        }

        const prev = existing.block as Extract<TranscriptBlock, { kind: "tool" }>;
        const hasName = folded.payload.title ?? folded.payload.name ?? folded.payload.toolName;
        existing.block = {
          kind: "tool",
          label: hasName ? folded.label : prev.label,
          status: folded.status,
          meta: prev.meta,
          args: folded.args ?? prev.args,
          result: folded.result ?? prev.result,
          error: folded.error ?? prev.error,
        };
        existing.open = folded.status === "running";
        const prevPayload =
          existing.payload && typeof existing.payload === "object" && !Array.isArray(existing.payload)
            ? (existing.payload as Record<string, unknown>)
            : {};
        existing.payload = { ...prevPayload, ...folded.payload };
        existing.rev += 1;
        return;
      }

      case "notice": {
        this.closeText(closeKey);
        const tag = !this.taskScoped && ev.taskId ? `${ev.taskId} ${folded.tag}` : folded.tag;
        const glyph = folded.glyph === "cross" ? "✗" : folded.glyph === "pause" ? "⏸" : undefined;
        this.push(
          {
            id: this.nextId++,
            rev: 1,
            open: false,
            taskId: ev.taskId ?? null,
            createdAt: ev.createdAt,
            block: {
              kind: "receipt",
              tone: folded.tone,
              glyph,
              tag,
              text: folded.text,
              hint: formatClock(ev.createdAt),
            },
          },
          taskKey,
        );
        return;
      }
    }
  }
}
