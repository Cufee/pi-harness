import type { EventRecord } from "../control-plane/db.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import { firstLine, formatClock, formatCountdown, formatToolLabel, sanitizeLine, sanitizeText, type Tone } from "./core/index.js";

/**
 * Structured model behind `LiveTranscriptScreen`: folds `watch.start` replay + live frames into
 * role blocks (assistant prose, thinking, tool calls, events) and flattens them into logical lines.
 * Every logical line has a stable `key` (block id + line slot) so selection, cursor, and reading
 * anchors survive re-wrapping, streaming growth, and tool expand/collapse.
 */

export type LineRole =
  | "spacer"
  | "assistant-header"
  | "thought-header"
  | "prose"
  | "heading"
  | "list"
  | "fence"
  | "code"
  | "thought"
  | "tool-header"
  | "tool-label"
  | "tool-body"
  | "tool-error"
  | "event";

export interface TranscriptLine {
  key: string;
  blockId: number;
  role: LineRole;
  /** Sanitized display text (no styling, no wrapping). */
  text: string;
  /** Exact text placed on the clipboard when this line is selected. */
  copy: string;
  tone?: Tone;
  /** Tool header only: current status + expansion, used for icon/fold rendering. */
  tool?: { status: "running" | "ok" | "error"; expanded: boolean };
}

interface TextBlock {
  id: number;
  kind: "assistant" | "thought";
  taskKey: string;
  taskId: string | null;
  createdAt: number;
  text: string;
  open: boolean;
}

interface ToolBlock {
  id: number;
  kind: "tool";
  taskKey: string;
  taskId: string | null;
  createdAt: number;
  toolId?: string;
  name: string;
  status: "running" | "ok" | "error";
  args?: string;
  result?: string;
  error?: string;
  expanded: boolean;
}

interface EventBlock {
  id: number;
  kind: "event";
  taskKey: string;
  createdAt: number;
  text: string;
  tone: Tone;
}

type Block = TextBlock | ToolBlock | EventBlock;

const MAX_BLOCKS = 2000;
const TRIM_TO_BLOCKS = 1500;

function toolStatus(raw: string): ToolBlock["status"] {
  if (raw === "completed" || raw === "ok") return "ok";
  if (raw === "failed" || raw === "error") return "error";
  return "running";
}

function detailText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Pretty-prints JSON payloads for reading; non-JSON (including truncated previews) stays verbatim. */
function bodyLines(raw: string): string[] {
  let text = raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      text = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // keep raw
    }
  }
  return sanitizeText(text).split("\n");
}

export class LiveTranscriptModel {
  private blocks: Block[] = [];
  private nextId = 1;
  private readonly openText = new Map<string, TextBlock>();
  private readonly toolsById = new Map<string, ToolBlock>();
  private readonly lineCache = new Map<number, { sig: string; lines: TranscriptLine[] }>();

  constructor(private readonly taskScoped: boolean) {}

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  /** Appends a failure notice (e.g. `watch.start` rejection). */
  pushNotice(text: string, tone: Tone = "danger"): void {
    this.push({ id: this.nextId++, kind: "event", taskKey: "__run__", createdAt: Date.now(), text: sanitizeLine(text), tone });
  }

  private who(taskId: string | null | undefined): string {
    return !this.taskScoped && taskId ? `[${taskId}] ` : "";
  }

  private push(b: Block): void {
    this.blocks.push(b);
    if (this.blocks.length > MAX_BLOCKS) {
      const dropped = this.blocks.splice(0, this.blocks.length - TRIM_TO_BLOCKS);
      for (const d of dropped) {
        this.lineCache.delete(d.id);
        if (d.kind === "tool" && d.toolId) this.toolsById.delete(`${d.taskKey}\u0000${d.toolId}`);
        if ((d.kind === "assistant" || d.kind === "thought") && this.openText.get(d.taskKey) === d) this.openText.delete(d.taskKey);
      }
    }
  }

  private closeText(taskKey?: string): void {
    if (taskKey === undefined) {
      for (const b of this.openText.values()) b.open = false;
      this.openText.clear();
      return;
    }
    const b = this.openText.get(taskKey);
    if (b) b.open = false;
    this.openText.delete(taskKey);
  }

  private appendText(kind: "assistant" | "thought", ev: EventRecord | DaemonEventFrame, taskKey: string, delta: string): void {
    let b = this.openText.get(taskKey);
    if (b && b.kind !== kind) {
      this.closeText(taskKey);
      b = undefined;
    }
    if (!b) {
      if (!delta.trim()) return;
      b = { id: this.nextId++, kind, taskKey, taskId: ev.taskId ?? null, createdAt: ev.createdAt, text: "", open: true };
      this.openText.set(taskKey, b);
      this.push(b);
    }
    b.text += delta;
  }

  ingest(ev: EventRecord | DaemonEventFrame): void {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const taskKey = ev.taskId ?? "__run__";
    const who = this.who(ev.taskId);
    const closeKey = ev.taskId ? taskKey : undefined;

    if (ev.type === "agent.text_delta") {
      this.appendText("assistant", ev, taskKey, String(p.text ?? p.delta ?? ""));
      return;
    }
    if (ev.type === "agent.thought_delta") {
      this.appendText("thought", ev, taskKey, String(p.text ?? p.delta ?? ""));
      return;
    }
    if (ev.type === "agent.tool") {
      this.closeText(taskKey);
      const toolId = p.id != null ? String(p.id) : undefined;
      const mapKey = toolId ? `${taskKey}\u0000${toolId}` : undefined;
      const rawName = String(p.title ?? p.name ?? p.toolName ?? "tool");
      let b = mapKey ? this.toolsById.get(mapKey) : undefined;
      if (!b) {
        b = {
          id: this.nextId++,
          kind: "tool",
          taskKey,
          taskId: ev.taskId ?? null,
          createdAt: ev.createdAt,
          toolId,
          name: formatToolLabel(rawName),
          status: "running",
          expanded: false,
        };
        if (mapKey) this.toolsById.set(mapKey, b);
        this.push(b);
      } else if (p.title ?? p.name ?? p.toolName) {
        b.name = formatToolLabel(rawName);
      }
      b.status = toolStatus(String(p.status ?? "running"));
      b.args = detailText(p.args) ?? b.args;
      b.result = detailText(p.result) ?? b.result;
      b.error = detailText(p.error) ?? b.error;
      return;
    }
    if (ev.type === "agent.tool_start" || ev.type === "agent.tool_end") {
      this.closeText();
      const name = formatToolLabel(String(p.toolName ?? p.name ?? p.title ?? "tool"));
      if (ev.type === "agent.tool_end") {
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const b = this.blocks[i]!;
          if (b.kind === "tool" && b.taskKey === taskKey && b.name === name && b.status === "running") {
            b.status = "ok";
            return;
          }
        }
      }
      this.push({
        id: this.nextId++,
        kind: "tool",
        taskKey,
        taskId: ev.taskId ?? null,
        createdAt: ev.createdAt,
        name,
        status: ev.type === "agent.tool_start" ? "running" : "ok",
        expanded: false,
      });
      return;
    }

    this.closeText(closeKey);
    const clock = `[${formatClock(ev.createdAt)}] `;
    let text: string;
    let tone: Tone = "muted";
    if (ev.type === "agent.rollover") {
      const gen = p.generation ?? p.nextGeneration ?? "";
      const reason = p.reason ? ` (${sanitizeLine(String(p.reason))})` : "";
      text = `${clock}${who}↻ rollover${gen ? ` → gen ${gen}` : ""}${reason}`;
      tone = "info";
    } else if (ev.type === "agent.error") {
      text = `${clock}${who}✗ ERROR: ${sanitizeLine(String(p.message ?? p.error ?? "agent error"))}`;
      tone = "danger";
    } else if (ev.type.startsWith("quota.")) {
      const reason = sanitizeLine(String(p.reason ?? p.mode ?? ""));
      const wake = p.resumeAt ? ` · resume ${formatCountdown(p.resumeAt as number | string)}` : "";
      text = `${clock}⏸ ${ev.type}${reason ? ` · ${reason}` : ""}${wake}`;
      tone = "warn";
    } else {
      const summary = p.summary ?? p.status ?? p.to ?? p.title ?? p.message ?? "";
      text = `${clock}${who}${ev.type}${summary ? ` · ${sanitizeLine(String(summary))}` : ""}`;
    }
    this.push({ id: this.nextId++, kind: "event", taskKey, createdAt: ev.createdAt, text: sanitizeLine(text), tone });
  }

  /** Flips one tool block's expansion. Returns false when `blockId` is not a tool. */
  toggleTool(blockId: number): boolean {
    const b = this.blocks.find((x) => x.id === blockId);
    if (!b || b.kind !== "tool") return false;
    b.expanded = !b.expanded;
    return true;
  }

  /** Flattened logical lines in display order. */
  lines(): TranscriptLine[] {
    const out: TranscriptLine[] = [];
    let prevKind: Block["kind"] | null = null;
    for (const b of this.blocks) {
      const blockLines = this.blockLines(b);
      if (blockLines.length === 0) continue;
      // Breathing room before each prose/thinking section and when leaving one.
      if (prevKind !== null && (b.kind === "assistant" || b.kind === "thought" || prevKind === "assistant" || prevKind === "thought")) {
        out.push({ key: `${b.id}:sp`, blockId: b.id, role: "spacer", text: "", copy: "" });
      }
      out.push(...blockLines);
      prevKind = b.kind;
    }
    return out;
  }

  private blockLines(b: Block): TranscriptLine[] {
    const sig =
      b.kind === "tool"
        ? `${b.name}\u0000${b.status}\u0000${b.expanded}\u0000${b.args ?? ""}\u0000${b.result ?? ""}\u0000${b.error ?? ""}`
        : b.text;
    const cached = this.lineCache.get(b.id);
    if (cached && cached.sig === sig) return cached.lines;
    const lines = this.buildBlockLines(b);
    this.lineCache.set(b.id, { sig, lines });
    return lines;
  }

  private buildBlockLines(b: Block): TranscriptLine[] {
    const id = b.id;
    if (b.kind === "event") {
      return [{ key: `${id}:0`, blockId: id, role: "event", text: b.text, copy: b.text, tone: b.tone }];
    }
    if (b.kind === "tool") {
      const who = this.who(b.taskId);
      const icon = b.status === "ok" ? "✓" : b.status === "error" ? "✗" : "▶";
      const preview = b.expanded ? "" : (b.error ?? b.result ?? b.args ?? "");
      const header = `[${formatClock(b.createdAt)}] ${who}${icon} ${b.name}${preview ? ` — ${firstLine(preview, 90)}` : ""}`;
      const out: TranscriptLine[] = [
        { key: `${id}:h`, blockId: id, role: "tool-header", text: header, copy: header, tool: { status: b.status, expanded: b.expanded } },
      ];
      if (!b.expanded) return out;
      const sections: Array<[string, string, string | undefined]> = [
        ["a", "args", b.args],
        ["r", "result", b.result],
        ["e", "error", b.error],
      ];
      let any = false;
      for (const [slot, label, value] of sections) {
        if (value === undefined) continue;
        any = true;
        out.push({ key: `${id}:${slot}`, blockId: id, role: "tool-label", text: label, copy: `${label}:` });
        bodyLines(value).forEach((line, i) => {
          out.push({ key: `${id}:${slot}${i}`, blockId: id, role: slot === "e" ? "tool-error" : "tool-body", text: line, copy: line });
        });
      }
      if (!any) out.push({ key: `${id}:none`, blockId: id, role: "tool-label", text: "no args or output reported", copy: "" });
      return out;
    }

    const who = this.who(b.taskId);
    const source = sanitizeText(b.text).split("\n");
    let first = 0;
    while (first < source.length && !source[first]!.trim()) first++;
    let last = source.length - 1;
    while (last >= first && !source[last]!.trim()) last--;
    if (first > last) return [];

    const out: TranscriptLine[] = [];
    const clock = formatClock(b.createdAt);
    if (b.kind === "thought") {
      const header = `${who}thinking · ${clock}`;
      out.push({ key: `${id}:h`, blockId: id, role: "thought-header", text: header, copy: header });
      for (let i = first; i <= last; i++) {
        const line = source[i]!;
        if (!line.trim()) continue;
        out.push({ key: `${id}:${i}`, blockId: id, role: "thought", text: line, copy: line });
      }
      return out;
    }

    const header = `${who}assistant · ${clock}`;
    out.push({ key: `${id}:h`, blockId: id, role: "assistant-header", text: header, copy: header });
    let inCode = false;
    for (let i = first; i <= last; i++) {
      const line = source[i]!;
      let role: LineRole;
      let text = line;
      if (/^\s*(```|~~~)/.test(line)) {
        role = "fence";
        inCode = !inCode;
        text = inCode ? line.trim().replace(/^(```|~~~)/, "").trim() || "code" : "";
      } else if (inCode) {
        role = "code";
      } else if (/^#{1,6}\s/.test(line)) {
        role = "heading";
        text = line.replace(/^#{1,6}\s+/, "");
      } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
        role = "list";
      } else {
        role = "prose";
      }
      out.push({ key: `${id}:${i}`, blockId: id, role, text, copy: line });
    }
    return out;
  }
}
