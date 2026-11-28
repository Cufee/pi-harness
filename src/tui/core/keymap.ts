import { getNativeClipboard } from "@earendil-works/pi-tui";
import type { EntityKind, EntityRef as WireEntityRef } from "../../protocol/daemon-rpc.js";
import { clamp, visibleWidth } from "./text.js";
import type { Theme } from "./tokens.js";

export interface Hint {
  key: string;
  label: string;
}

/** Renders a single-line keybinding hint bar, dropping trailing hints cleanly when narrow. */
export function renderHintBar(hints: Hint[], width: number, theme: Theme): string {
  const w = Math.max(1, Math.floor(width));
  const sep = theme.muted(` ${theme.glyphs.sep} `);
  const sepW = visibleWidth(sep);
  const parts: string[] = [];
  let used = 0;

  for (const h of hints) {
    const piece = `${theme.accentBold(h.key)} ${theme.muted(h.label)}`;
    const pw = visibleWidth(piece);
    const addW = parts.length === 0 ? pw : sepW + pw;
    if (parts.length > 0 && used + addW > w) break;
    parts.push(piece);
    used += addW;
  }

  return clamp(parts.join(sep), w);
}

/** Copies text to the host clipboard via native clipboard and OSC 52 fallback. */
export function yankText(text: string, writeOsc?: (seq: string) => void): boolean {
  if (!text) return false;
  let copied = false;
  try {
    const clip = getNativeClipboard();
    if (clip?.setText) {
      void clip.setText(text).catch(() => {});
      copied = true;
    }
  } catch {
    // Fall through to OSC 52
  }
  if (writeOsc) {
    try {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      writeOsc(`\x1b]52;c;${b64}\x07`);
      copied = true;
    } catch {
      // ignore
    }
  }
  return copied;
}

export type { EntityKind };

export interface EntityRef extends WireEntityRef {
  label: string;
  /** Optional inline payload for ephemeral receipts like Director tool calls. */
  payload?: unknown;
}

/**
 * Ordered ring of every entity recently surfaced in the transcript or live feed.
 * Powers `Ctrl+X` (inspect latest surfaced entity).
 */
export class RecentRefsRing {
  private readonly items: EntityRef[] = [];
  private cursor = -1;
  private readonly maxItems: number;

  constructor(maxItems = 80) {
    this.maxItems = maxItems;
  }

  push(ref: EntityRef): void {
    const key = `${ref.kind}:${ref.id}`;
    const existingIdx = this.items.findIndex((x) => `${x.kind}:${x.id}` === key);
    if (existingIdx >= 0) this.items.splice(existingIdx, 1);
    this.items.push(ref);
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
    this.cursor = this.items.length - 1;
  }

  latest(): EntityRef | undefined {
    return this.items[this.items.length - 1];
  }

  step(delta: -1 | 1): EntityRef | undefined {
    if (this.items.length === 0) return undefined;
    if (this.cursor < 0) this.cursor = this.items.length - 1;
    else this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor + delta));
    return this.items[this.cursor];
  }

  get size(): number {
    return this.items.length;
  }
}
