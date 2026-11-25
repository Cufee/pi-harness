/**
 * Pure reconnect reconciliation for persisted assistant history rows against
 * live-frozen scrollback segments, live-rendered tool cards, and the detached
 * live streaming tail.
 *
 * Rules:
 * - Structural live-tool acknowledgement (before R1): every unseen assistant row
 *   preceding a live-matched `tool_output` row was persisted before that card and
 *   is already frozen on screen, so it is skipped by structure with no text
 *   comparison, and frozen segments closed by that card are consumed whole.
 * - R1: remaining unclosed frozen segments match subsequent assistant rows by
 *   strict prefix (ignoring edge whitespace, never `indexOf`).
 * - R2: once frozen segments are exhausted, non-empty assistant rows render and
 *   reconcile against the detached tail by strict prefix (mismatch discards tail).
 * - R3: on an idle reopen with daemon restart evidence, a non-empty tail remainder
 *   is unpersisted text to append once; without restart evidence (or on a busy
 *   reopen), the tail is discarded because the live daemon persisted everything it kept.
 */

export interface ReconcileRow {
  readonly role: string;
  readonly content: string;
  readonly seq?: number;
}

export interface FrozenSegment {
  /** Assistant text already frozen into immutable scrollback during the active turn. */
  readonly text: string;
  /**
   * Count of live structured tool cards already rendered in this turn before this
   * segment was frozen. Any matched live tool card with `ordinal > afterLiveToolCount`
   * closed this segment on screen.
   */
  readonly afterLiveToolCount: number;
}

export interface LiveRenderedTool {
  /** 1-based ordinal of this live structured tool card within the active turn. */
  readonly ordinal: number;
  /** Fingerprint matching `rowToolFingerprint(row)` for replay deduplication. */
  readonly fingerprint: string;
}

export interface MatchedLiveTool {
  /** Index of the matched `tool_output` row in `rows`. */
  readonly rowIndex: number;
  /** 1-based ordinal of the live tool card matched to that row. */
  readonly ordinal: number;
}

export interface MatchLiveToolsResult {
  /** Live-matched `tool_output` rows in ascending row/ordinal order. */
  readonly matches: readonly MatchedLiveTool[];
  /** Indices into `rows` of `tool_output` rows already rendered live (skip on replay). */
  readonly skipToolIndices: ReadonlySet<number>;
  /** Unmatched live tool cards still pending in FIFO order. */
  readonly remainingLiveTools: readonly LiveRenderedTool[];
}

/**
 * Matches persisted `tool_output` rows against the FIFO queue of live-rendered tool
 * cards. Computed once per resync and shared between `reconcileAssistantHistory`
 * and `renderHistoryRows` so reconciliation and rendering never disagree.
 */
export function matchLiveToolRows<T extends ReconcileRow>(
  rows: readonly T[],
  liveTools: readonly LiveRenderedTool[],
  getToolFingerprint: (row: T) => string,
): MatchLiveToolsResult {
  const remaining = [...liveTools];
  const matches: MatchedLiveTool[] = [];
  const skipToolIndices = new Set<number>();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.role !== "tool_output") continue;
    if (remaining.length === 0) break;
    if (remaining[0]!.fingerprint === getToolFingerprint(row)) {
      const matched = remaining.shift()!;
      matches.push({ rowIndex: i, ordinal: matched.ordinal });
      skipToolIndices.add(i);
    }
  }

  return { matches, skipToolIndices, remainingLiveTools: remaining };
}

export interface ReconcileAssistantInput<T extends ReconcileRow = ReconcileRow> {
  /** Assistant segments this turn already froze into immutable scrollback during live rendering, in order. */
  readonly frozen: readonly FrozenSegment[];
  /** Unfrozen live assistant text detached at reconnect. */
  readonly tail: string;
  /** Fetched persisted rows not yet rendered by seq, in order. */
  readonly rows: readonly T[];
  /** Whether the reopened session is still busy on the daemon. */
  readonly busy: boolean;
  /** Whether reconnect observed daemon restart evidence (pid change, daemon.stopping, DAEMON_RELOADING). */
  readonly daemonRestarted: boolean;
  /** Live-matched `tool_output` rows in `rows`, in row order (from `matchLiveToolRows`). */
  readonly liveToolMatches?: readonly MatchedLiveTool[];
}

export interface ReconcileAssistantResult<T extends ReconcileRow = ReconcileRow> {
  /** Persisted assistant rows to render, in order. */
  readonly renderRows: readonly T[];
  /** Persisted assistant rows to skip (acknowledged by live tool card, covered by frozen scrollback, or blank), in order. */
  readonly skipRows: readonly T[];
  /** Indices into `input.rows` for assistant rows that should be skipped. */
  readonly skipIndices: ReadonlySet<number>;
  /** Unpersisted tail remainder to append once on idle reopen after a daemon restart (otherwise `""`). */
  readonly tailRemainder: string;
  /** Unconsumed frozen segments remaining after matching persisted rows. */
  readonly remainingFrozen: readonly FrozenSegment[];
}

export function reconcileAssistantHistory<T extends ReconcileRow>(
  input: ReconcileAssistantInput<T>,
): ReconcileAssistantResult<T> {
  const remainingFrozen: FrozenSegment[] = input.frozen
    .map((segment) => ({
      text: segment.text.trim(),
      afterLiveToolCount: segment.afterLiveToolCount,
    }))
    .filter((segment) => segment.text.length > 0);
  let tailRemaining = input.tail.trim();

  const renderRows: T[] = [];
  const skipRows: T[] = [];
  const skipIndices = new Set<number>();

  // Structural live-tool acknowledgement (before R1):
  // Every unseen assistant row before a live-matched tool_output row was persisted
  // before that card and is already frozen on screen (even if the frozen text also
  // includes earlier text the daemon discarded on an overflow retry). Skip those
  // assistant rows without text comparison and consume the frozen segments closed
  // by that card.
  const liveToolMatches = input.liveToolMatches ?? [];
  const lastMatchedTool =
    liveToolMatches.length > 0 ? liveToolMatches[liveToolMatches.length - 1]! : null;
  if (lastMatchedTool) {
    for (let i = remainingFrozen.length - 1; i >= 0; i -= 1) {
      if (remainingFrozen[i]!.afterLiveToolCount < lastMatchedTool.ordinal) {
        remainingFrozen.splice(i, 1);
      }
    }
  }

  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i]!;
    if (row.role !== "assistant") continue;

    if (lastMatchedTool && i < lastMatchedTool.rowIndex) {
      skipRows.push(row);
      skipIndices.add(i);
      continue;
    }

    const rowText = row.content.trim();
    if (!rowText) {
      skipRows.push(row);
      skipIndices.add(i);
      continue;
    }

    // R1: While unclosed frozen text remains, a row that is a prefix of the remaining
    // frozen text is already on screen. Consume that prefix and skip the row. A row
    // that is not a prefix ends frozen matching: drop the frozen remainder and render
    // this row and all later rows.
    if (remainingFrozen.length > 0) {
      const head = remainingFrozen[0]!;
      if (head.text.startsWith(rowText)) {
        const rest = head.text.slice(rowText.length).trim();
        if (rest) {
          remainingFrozen[0] = { text: rest, afterLiveToolCount: head.afterLiveToolCount };
        } else {
          remainingFrozen.shift();
        }
        skipRows.push(row);
        skipIndices.add(i);
        continue;
      }
      remainingFrozen.length = 0;
    }

    // R2: Once frozen text is exhausted, every non-empty assistant row is rendered and
    // reconciled against the detached tail.
    renderRows.push(row);
    if (tailRemaining) {
      if (tailRemaining.startsWith(rowText)) {
        tailRemaining = tailRemaining.slice(rowText.length).trim();
      } else if (rowText.startsWith(tailRemaining)) {
        tailRemaining = "";
      } else {
        // Persisted record differs from what was streamed: history wins, discard tail.
        tailRemaining = "";
      }
    }
  }

  // R3: On an idle reopen after a daemon restart, a non-empty tail remainder is
  // unpersisted text to append once. Without restart evidence, the live daemon ended
  // the turn itself and persisted everything it kept, so discard the tail. On a busy
  // reopen, the tail is always discarded (rows + daemon activePartial are truth).
  const tailRemainder = !input.busy && input.daemonRestarted ? tailRemaining : "";

  return {
    renderRows,
    skipRows,
    skipIndices,
    tailRemainder,
    remainingFrozen,
  };
}
