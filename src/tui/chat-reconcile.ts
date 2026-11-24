/**
 * Pure reconnect reconciliation for persisted assistant history rows against
 * live-frozen scrollback segments and the detached live streaming tail.
 *
 * Only `assistant` rows participate; `user`, `tool_output`, and `system_notice`
 * rows never act as boundaries for this algorithm. Comparisons ignore edge
 * whitespace and strictly use prefix checks (never `indexOf`).
 */

export interface ReconcileRow {
  readonly role: string;
  readonly content: string;
  readonly seq?: number;
}

export interface ReconcileAssistantInput<T extends ReconcileRow = ReconcileRow> {
  /** Assistant text this turn already froze into immutable scrollback during live rendering, in order. */
  readonly frozen: readonly string[];
  /** Unfrozen live assistant text detached at reconnect. */
  readonly tail: string;
  /** Fetched persisted rows not yet rendered by seq, in order. */
  readonly rows: readonly T[];
  /** Whether the reopened session is still busy on the daemon. */
  readonly busy: boolean;
}

export interface ReconcileAssistantResult<T extends ReconcileRow = ReconcileRow> {
  /** Persisted assistant rows to render, in order. */
  readonly renderRows: readonly T[];
  /** Persisted assistant rows to skip (covered by frozen scrollback, or blank), in order. */
  readonly skipRows: readonly T[];
  /** Indices into `input.rows` for assistant rows that should be skipped. */
  readonly skipIndices: ReadonlySet<number>;
  /** Unpersisted tail remainder to append once on idle reopen (always `""` on busy reopen). */
  readonly tailRemainder: string;
  /** Unconsumed frozen segments remaining after matching persisted rows. */
  readonly remainingFrozen: readonly string[];
}

export function reconcileAssistantHistory<T extends ReconcileRow>(
  input: ReconcileAssistantInput<T>,
): ReconcileAssistantResult<T> {
  const remainingFrozen = input.frozen.map((segment) => segment.trim()).filter(Boolean);
  let tailRemaining = input.tail.trim();

  const renderRows: T[] = [];
  const skipRows: T[] = [];
  const skipIndices = new Set<number>();

  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i]!;
    if (row.role !== "assistant") continue;

    const rowText = row.content.trim();
    if (!rowText) {
      skipRows.push(row);
      skipIndices.add(i);
      continue;
    }

    // R1: While frozen text remains, a row that is a prefix of the remaining frozen text
    // is already on screen. Consume that prefix and skip the row. A row that is not a prefix
    // ends frozen matching: drop the frozen remainder and render this row and all later rows.
    if (remainingFrozen.length > 0) {
      const head = remainingFrozen[0]!;
      if (head.startsWith(rowText)) {
        const rest = head.slice(rowText.length).trim();
        if (rest) {
          remainingFrozen[0] = rest;
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

  // R3: On an idle reopen, a non-empty tail remainder is unpersisted text to append once.
  // On a busy reopen, the tail is always discarded (rows + daemon activePartial are truth).
  const tailRemainder = input.busy ? "" : tailRemaining;

  return {
    renderRows,
    skipRows,
    skipIndices,
    tailRemainder,
    remainingFrozen,
  };
}
