import { resolveStorageLayout, type StorageLayout } from "./paths.js";

export interface WriteNoteTextRoots {
  noteRoots?: readonly string[];
  extraRoots?: readonly string[];
}

export interface StorageText {
  artifactsRoot(): string;
  goalEvidenceDirTemplate(): string;
  directorNoteLocation(extraWriteRootsLabel: string): string;
  writeNoteTool(roots?: WriteNoteTextRoots): string;
  writeNotePathParam(roots?: WriteNoteTextRoots): string;
  directorNoteRootAlternative(): string;
  dossierInvalidDirectoryReason(): string;
  dossierSymlinkWhat(path: string): string;
}

const HARNESS_DIR = ".harness";
const LEGACY_NOTE_PATHS_SENTENCE_CODE =
  "Old workspace-relative `.harness/goals/...` and `.harness/notes/...` paths are still accepted and mapped to the new location.";
const LEGACY_NOTE_PATHS_SENTENCE_PLAIN =
  "Old workspace-relative .harness/goals/... and .harness/notes/... paths are still accepted and mapped to the new location.";

const LEGACY_STORAGE_TEXT: StorageText = {
  artifactsRoot(): string {
    return `${HARNESS_DIR}/artifacts`;
  },

  goalEvidenceDirTemplate(): string {
    return `<repo>/${HARNESS_DIR}/goals/<goalId>`;
  },

  directorNoteLocation(extraWriteRootsLabel: string): string {
    return `${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/, or a configured extra write root (${extraWriteRootsLabel})`;
  },

  writeNoteTool(roots?: WriteNoteTextRoots): string {
    const extraRoots = roots?.extraRoots;
    if (extraRoots === undefined) {
      return `Logged Director note/report writer scoped strictly to \`${HARNESS_DIR}/goals/\`, \`${HARNESS_DIR}/notes/\`, or configured \`extraWriteRoots\` (never writes tracked repository source code).`;
    }
    const hasRoots = extraRoots.length > 0;
    const extraText = hasRoots
      ? `or these configured extraWriteRoots: ${extraRoots.join(", ")}`
      : "no extraWriteRoots configured";
    return hasRoots
      ? `Logged Director note/report writer scoped strictly to \`${HARNESS_DIR}/goals/\`, \`${HARNESS_DIR}/notes/\`, ${extraText} (never writes tracked repository source code).`
      : `Logged Director note/report writer scoped strictly to \`${HARNESS_DIR}/goals/\`, \`${HARNESS_DIR}/notes/\` (${extraText}; never writes tracked repository source code).`;
  },

  writeNotePathParam(roots?: WriteNoteTextRoots): string {
    const extraRoots = roots?.extraRoots;
    if (extraRoots === undefined) {
      return `Destination file under ${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/, or extraWriteRoots.`;
    }
    const hasRoots = extraRoots.length > 0;
    const extraText = hasRoots
      ? `or these configured extraWriteRoots: ${extraRoots.join(", ")}`
      : "no extraWriteRoots configured";
    return hasRoots
      ? `Destination file under ${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/, ${extraText}.`
      : `Destination file under ${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/ (${extraText}).`;
  },

  directorNoteRootAlternative(): string {
    return `Write under ${HARNESS_DIR}/goals, ${HARNESS_DIR}/notes, or a configured worktree.extraWriteRoots path. Code changes go through goal_create and goal_commit.`;
  },

  dossierInvalidDirectoryReason(): string {
    return `Dossiers are stored only in regular directories under ${HARNESS_DIR}/artifacts to keep run artifacts confined.`;
  },

  dossierSymlinkWhat(path: string): string {
    return `Dossier must be a non-symlink path under ${HARNESS_DIR}/artifacts: ${path}.`;
  },
};

const DATA_DIR_STORAGE_TEXT: StorageText = {
  artifactsRoot(): string {
    return "the harness artifacts directory (env HARNESS_ARTIFACTS_DIR)";
  },

  goalEvidenceDirTemplate(): string {
    return "<dataDir>/projects/<project>/chats/<chat>/goals/<goalId>";
  },

  directorNoteLocation(extraWriteRootsLabel: string): string {
    return `this chat's goals/ and notes/ directories or the project notes directory under the harness data directory, or a configured extra write root (${extraWriteRootsLabel}). Old workspace-relative .harness/goals/... and .harness/notes/... paths are still accepted and mapped to the new location`;
  },

  writeNoteTool(roots?: WriteNoteTextRoots): string {
    const noteRoots = roots?.noteRoots && roots.noteRoots.length > 0 ? roots.noteRoots : undefined;
    const extraRoots = roots?.extraRoots;
    if (extraRoots === undefined) {
      const primary = noteRoots
        ? noteRoots.join(", ")
        : "this chat's `goals/` and `notes/` directories, the project notes directory under the harness data directory";
      return `Logged Director note/report writer scoped strictly to ${primary}, or configured \`extraWriteRoots\` (never writes tracked repository source code). ${LEGACY_NOTE_PATHS_SENTENCE_CODE}`;
    }
    if (extraRoots.length > 0) {
      const primary = noteRoots
        ? noteRoots.join(", ")
        : "this chat's `goals/` and `notes/` directories, the project notes directory under the harness data directory";
      return `Logged Director note/report writer scoped strictly to ${primary}, or these configured extraWriteRoots: ${extraRoots.join(", ")} (never writes tracked repository source code). ${LEGACY_NOTE_PATHS_SENTENCE_CODE}`;
    }
    const primary = noteRoots
      ? noteRoots.join(", ")
      : "this chat's `goals/` and `notes/` directories or the project notes directory under the harness data directory";
    return `Logged Director note/report writer scoped strictly to ${primary} (no extraWriteRoots configured; never writes tracked repository source code). ${LEGACY_NOTE_PATHS_SENTENCE_CODE}`;
  },

  writeNotePathParam(roots?: WriteNoteTextRoots): string {
    const noteRoots = roots?.noteRoots && roots.noteRoots.length > 0 ? roots.noteRoots : undefined;
    const extraRoots = roots?.extraRoots;
    if (extraRoots === undefined) {
      const primary = noteRoots
        ? noteRoots.join(", ")
        : "this chat's goals/ and notes/ directories, the project notes directory under the harness data directory";
      return `Destination file under ${primary}, or extraWriteRoots. ${LEGACY_NOTE_PATHS_SENTENCE_PLAIN}`;
    }
    if (extraRoots.length > 0) {
      const primary = noteRoots
        ? noteRoots.join(", ")
        : "this chat's goals/ and notes/ directories, the project notes directory under the harness data directory";
      return `Destination file under ${primary}, or these configured extraWriteRoots: ${extraRoots.join(", ")}. ${LEGACY_NOTE_PATHS_SENTENCE_PLAIN}`;
    }
    const primary = noteRoots
      ? noteRoots.join(", ")
      : "this chat's goals/ and notes/ directories or the project notes directory under the harness data directory";
    return `Destination file under ${primary} (no extraWriteRoots configured). ${LEGACY_NOTE_PATHS_SENTENCE_PLAIN}`;
  },

  directorNoteRootAlternative(): string {
    return `Write under this chat's goals/ or notes/ directory, the project notes directory under the harness data directory, or configured worktree.extraWriteRoots. ${LEGACY_NOTE_PATHS_SENTENCE_PLAIN} Code changes go through goal_create and goal_commit.`;
  },

  dossierInvalidDirectoryReason(): string {
    return "Dossiers are stored only in regular directories under the harness artifacts directory to keep run artifacts confined.";
  },

  dossierSymlinkWhat(path: string): string {
    return `Dossier must be a non-symlink path in a regular directory under the harness artifacts directory: ${path}.`;
  },
};

/** Returns layout-aware user-facing storage text helpers without requiring a config object. */
export function storageText(layout?: StorageLayout): StorageText {
  return resolveStorageLayout(layout) === "data-dir" ? DATA_DIR_STORAGE_TEXT : LEGACY_STORAGE_TEXT;
}
