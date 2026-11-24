import type { TaskRecord } from "../control-plane/db.js";
import { roleOf } from "./roles.js";
import type { Subject } from "./types.js";

const FILE_EXT_RE = /[^./\\]\.[A-Za-z][A-Za-z0-9_-]{0,11}$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Path-like tokens: contain "/" or end in a file extension; trailing punctuation stripped. */
export function pathHintsOf(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    if (!raw) continue;
    let token = raw.replace(/^[`"'([{<]+/, "").replace(/[`"'\])}>.,;:!?]+$/, "");
    if (!token || URL_SCHEME_RE.test(token)) continue;
    token = token.replace(/:\d+(?:-\d+)?$/, "").replace(/[`"'\])}>.,;:!?]+$/, "");
    if (!token || token === "/" || token === "./" || token === ".") continue;
    const normalized = token.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized) continue;
    if (normalized.includes("/") || FILE_EXT_RE.test(normalized)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
  }
  return out;
}

export function buildSubject(input: {
  task: TaskRecord;
  workspaceRoot: string;
  writeScopes: string[];
  writableExtraRoots: string[];
}): Subject {
  const { task } = input;
  const briefText = [task.title, task.objective, task.criteria]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return {
    id: task.id,
    taskId: task.id,
    runId: task.runId,
    role: roleOf(task),
    readOnly: task.readOnly,
    brief: { text: briefText, pathHints: pathHintsOf(briefText) },
    writeScopes: [...input.writeScopes],
    writableExtraRoots: [...input.writableExtraRoots],
    workspaceRoot: input.workspaceRoot,
  };
}

export function buildDirectorSubject(input: {
  sessionId: string;
  repoRoot: string;
  userMessage: string;
}): Subject {
  return {
    id: `chat:${input.sessionId}`,
    taskId: null,
    runId: null,
    role: "director",
    readOnly: true,
    brief: { text: input.userMessage, pathHints: pathHintsOf(input.userMessage) },
    writeScopes: [],
    writableExtraRoots: [],
    workspaceRoot: input.repoRoot,
  };
}
