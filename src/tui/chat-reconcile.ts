/**
 * Pure reconnect reconciliation for persisted assistant history rows against
 * live-frozen scrollback segments, live-rendered boundaries (structured tool
 * cards and accepted user steers), and the detached live streaming tail.
 *
 * Rules:
 * - Structural live-boundary acknowledgement (before R1): every unseen assistant
 *   row preceding a live-matched `tool_output` row or live-matched steer `user`
 *   row was persisted before that boundary and is already frozen on screen, so
 *   it is skipped by structure with no text comparison, and frozen segments
 *   closed by that boundary are consumed whole. Opening user messages of a turn
 *   are skipped as already rendered live when matched, but are not boundaries.
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
   * Count of live boundaries (structured tool cards and accepted steers) already
   * rendered in this turn before this segment was frozen. Any matched live
   * boundary with `ordinal > afterBoundaryCount` closed this segment on screen.
   */
  readonly afterBoundaryCount: number;
}

export interface LiveRenderedTool {
  /** 1-based boundary ordinal of this live structured tool card within the active turn. */
  readonly ordinal: number;
  /** Fingerprint matching `rowToolFingerprint(row)` for replay deduplication. */
  readonly fingerprint: string;
}

export interface LiveRenderedUser {
  /** User message text already rendered live in this turn. */
  readonly content: string;
  /**
   * 1-based boundary ordinal when this user card came from an accepted live steer
   * (which flushes assistant partial on the daemon and freezes live text on screen).
   * `null` for an opening user turn message, which is not a boundary.
   */
  readonly boundaryOrdinal: number | null;
}

export interface MatchedLiveBoundary {
  /** Index of the matched `tool_output` or steer `user` row in `rows`. */
  readonly rowIndex: number;
  /** 1-based boundary ordinal of the live tool card or accepted steer matched to that row. */
  readonly ordinal: number;
}

export interface MatchLiveBoundaryRowsResult {
  /** Live-matched boundary rows (`tool_output` and steer `user`) in ascending row order. */
  readonly matches: readonly MatchedLiveBoundary[];
  /** Indices into `rows` of `tool_output` rows already rendered live (skip on replay). */
  readonly skipToolIndices: ReadonlySet<number>;
  /** Indices into `rows` of `user` rows already rendered live (skip on replay). */
  readonly skipUserIndices: ReadonlySet<number>;
  /** Unmatched live tool cards still pending in FIFO order. */
  readonly remainingLiveTools: readonly LiveRenderedTool[];
  /** Unmatched live user cards still pending in FIFO order. */
  readonly remainingLiveUsers: readonly LiveRenderedUser[];
}

/**
 * Matches persisted `tool_output` and `user` rows against the FIFO queues of
 * live-rendered tool cards and live-rendered user cards. Computed once per resync
 * and shared between `reconcileAssistantHistory` and `renderHistoryRows` so
 * reconciliation and rendering never disagree.
 */
export function matchLiveBoundaryRows<T extends ReconcileRow>(
  rows: readonly T[],
  liveTools: readonly LiveRenderedTool[],
  liveUsers: readonly LiveRenderedUser[],
  getToolFingerprint: (row: T) => string,
): MatchLiveBoundaryRowsResult {
  const remainingTools = [...liveTools];
  const remainingUsers = [...liveUsers];
  const matches: MatchedLiveBoundary[] = [];
  const skipToolIndices = new Set<number>();
  const skipUserIndices = new Set<number>();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.role === "tool_output") {
      if (remainingTools.length > 0 && remainingTools[0]!.fingerprint === getToolFingerprint(row)) {
        const matched = remainingTools.shift()!;
        matches.push({ rowIndex: i, ordinal: matched.ordinal });
        skipToolIndices.add(i);
      }
    } else if (row.role === "user") {
      if (remainingUsers.length > 0 && remainingUsers[0]!.content === row.content) {
        const matched = remainingUsers.shift()!;
        skipUserIndices.add(i);
        if (matched.boundaryOrdinal !== null) {
          matches.push({ rowIndex: i, ordinal: matched.boundaryOrdinal });
        }
      }
    }
  }

  return {
    matches,
    skipToolIndices,
    skipUserIndices,
    remainingLiveTools: remainingTools,
    remainingLiveUsers: remainingUsers,
  };
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
  /** Whether reconnect observed a daemon restart (known PID change; intent signals only when a PID is unknown). */
  readonly daemonRestarted: boolean;
  /** Live-matched boundary rows (`tool_output` and steer `user`) in `rows`, in row order (from `matchLiveBoundaryRows`). */
  readonly liveBoundaryMatches?: readonly MatchedLiveBoundary[];
}

export interface ReconcileAssistantResult<T extends ReconcileRow = ReconcileRow> {
  /** Persisted assistant rows to render, in order. */
  readonly renderRows: readonly T[];
  /** Persisted assistant rows to skip (acknowledged by live boundary, covered by frozen scrollback, or blank), in order. */
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
      afterBoundaryCount: segment.afterBoundaryCount,
    }))
    .filter((segment) => segment.text.length > 0);
  let tailRemaining = input.tail.trim();

  const renderRows: T[] = [];
  const skipRows: T[] = [];
  const skipIndices = new Set<number>();

  // Structural live-boundary acknowledgement (before R1):
  // Every unseen assistant row before a live-matched tool_output or steer user row was
  // persisted before that boundary and is already frozen on screen (even if the frozen
  // text also includes earlier text the daemon discarded on an overflow retry). Skip
  // those assistant rows without text comparison and consume the frozen segments closed
  // by that boundary.
  const liveBoundaryMatches = input.liveBoundaryMatches ?? [];
  const lastMatchedBoundary =
    liveBoundaryMatches.length > 0 ? liveBoundaryMatches[liveBoundaryMatches.length - 1]! : null;
  if (lastMatchedBoundary) {
    for (let i = remainingFrozen.length - 1; i >= 0; i -= 1) {
      if (remainingFrozen[i]!.afterBoundaryCount < lastMatchedBoundary.ordinal) {
        remainingFrozen.splice(i, 1);
      }
    }
  }

  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i]!;
    if (row.role !== "assistant") continue;

    if (lastMatchedBoundary && i < lastMatchedBoundary.rowIndex) {
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
          remainingFrozen[0] = { text: rest, afterBoundaryCount: head.afterBoundaryCount };
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
