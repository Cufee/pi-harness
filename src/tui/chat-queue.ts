/**
 * Pure in-memory queue model for pending user messages in the TUI.
 * Holds delivery order, per-item state (`sending`, `queued`, or `unconfirmed`), and delivery
 * timing reason with no terminal or daemon client dependencies.
 */

export type ChatQueueItemState = "sending" | "queued" | "unconfirmed";

export type ChatQueueReason = "after_turn" | "reconnect" | "restart" | "control";

export interface ChatQueueItem {
  readonly id: string;
  readonly text: string;
  readonly state: ChatQueueItemState;
  readonly reason: ChatQueueReason;
  /** Optional hint for `unconfirmed` items (for example when a matching message exists in history). */
  readonly hint?: string;
}

export function formatQueueReason(reason: ChatQueueReason): string {
  switch (reason) {
    case "after_turn":
      return "sends after this turn";
    case "reconnect":
      return "sends when harnessd reconnects";
    case "restart":
      return "sends after harnessd restarts";
    case "control":
      return "sends when you take control";
  }
}

export function formatQueueItemState(item: Pick<ChatQueueItem, "state" | "reason" | "hint">): string {
  if (item.state === "sending") return "sending";
  if (item.state === "unconfirmed") {
    return item.hint ? `unconfirmed · ${item.hint}` : "may not have been delivered";
  }
  return `queued · ${formatQueueReason(item.reason)}`;
}

export class ChatQueueModel {
  private items: ChatQueueItem[] = [];
  private nextId = 1;

  get length(): number {
    return this.items.length;
  }

  /** Number of items eligible for automatic delivery (`queued` state only; excludes `sending` and `unconfirmed`). */
  get queuedLength(): number {
    let count = 0;
    for (const item of this.items) {
      if (item.state === "queued") count += 1;
    }
    return count;
  }

  /** Number of items the user can recall or drop (`queued` and `unconfirmed`, excluding in-flight `sending`). */
  get removableLength(): number {
    let count = 0;
    for (const item of this.items) {
      if (item.state !== "sending") count += 1;
    }
    return count;
  }

  list(): readonly ChatQueueItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  get(id: string): ChatQueueItem | undefined {
    const found = this.items.find((item) => item.id === id);
    return found ? { ...found } : undefined;
  }

  enqueue(
    text: string,
    opts?: { state?: ChatQueueItemState; reason?: ChatQueueReason; front?: boolean },
  ): ChatQueueItem {
    const item: ChatQueueItem = {
      id: `q-${this.nextId++}`,
      text,
      state: opts?.state ?? "queued",
      reason: opts?.reason ?? "after_turn",
    };
    if (opts?.front) this.items.unshift(item);
    else this.items.push(item);
    return { ...item };
  }

  markSending(id: string): ChatQueueItem | null {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const { hint: _hint, ...rest } = this.items[idx]!;
    const updated: ChatQueueItem = { ...rest, state: "sending" };
    this.items[idx] = updated;
    return { ...updated };
  }

  markQueued(id: string, reason: ChatQueueReason): ChatQueueItem | null {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const { hint: _hint, ...rest } = this.items[idx]!;
    const updated: ChatQueueItem = { ...rest, state: "queued", reason };
    this.items[idx] = updated;
    return { ...updated };
  }

  /** Marks an item whose transport dropped mid-send as `unconfirmed` so it is never resent automatically. */
  markUnconfirmed(id: string, hint?: string): ChatQueueItem | null {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const cur = this.items[idx]!;
    const nextHint = hint ?? cur.hint;
    const updated: ChatQueueItem = {
      id: cur.id,
      text: cur.text,
      reason: cur.reason,
      state: "unconfirmed",
      ...(nextHint ? { hint: nextHint } : {}),
    };
    this.items[idx] = updated;
    return { ...updated };
  }

  /** Removes and returns the next item ready for delivery (first item in `queued` state). */
  takeNext(): ChatQueueItem | null {
    const idx = this.items.findIndex((item) => item.state === "queued");
    if (idx < 0) return null;
    const [removed] = this.items.splice(idx, 1);
    return removed ? { ...removed } : null;
  }

  /** Returns the next item in `queued` state without removing it. */
  peekNextQueued(): ChatQueueItem | null {
    const found = this.items.find((item) => item.state === "queued");
    return found ? { ...found } : null;
  }

  removeById(id: string): ChatQueueItem | null {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const [removed] = this.items.splice(idx, 1);
    return removed ? { ...removed } : null;
  }

  /** Removes and returns the item at 0-based `index`, or null when out of range. */
  removeAt(index: number): ChatQueueItem | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return null;
    const [removed] = this.items.splice(index, 1);
    return removed ? { ...removed } : null;
  }

  /** Removes and returns the most recent removable item (`queued` or `unconfirmed`, skipping in-flight `sending`). */
  popLatest(): ChatQueueItem | null {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]!.state !== "sending") {
        const [removed] = this.items.splice(i, 1);
        return removed ? { ...removed } : null;
      }
    }
    return null;
  }

  /** Removes all removable items (`queued` and `unconfirmed`), leaving any in-flight `sending` items untouched. */
  clearQueued(): ChatQueueItem[] {
    const removed: ChatQueueItem[] = [];
    this.items = this.items.filter((item) => {
      if (item.state !== "sending") {
        removed.push({ ...item });
        return false;
      }
      return true;
    });
    return removed;
  }
}
