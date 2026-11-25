import { storageText } from "../storage/text.js";
import { formatNotice } from "./message.js";
import type { Notice } from "./types.js";

export class HarnessRejection extends Error {
  readonly notice: Notice;

  constructor(notice: Notice) {
    super(formatNotice(notice));
    this.name = "HarnessRejection";
    this.notice = notice;
  }
}

export function rejection(rule: string, what: string, why: string, allowed: string): HarnessRejection {
  return new HarnessRejection({
    level: "rejection",
    rule,
    what,
    why,
    alternative: allowed,
  });
}

function stripTrailingDot(value: string): string {
  return value.trim().replace(/\.+$/, "");
}

function formatCompactList(items: readonly string[] | string, maxItems = 3): string {
  if (typeof items === "string") return items.trim();
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length <= maxItems) return cleaned.join(", ");
  return `${cleaned.slice(0, maxItems).join(", ")}, +${cleaned.length - maxItems}`;
}

function compactWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

/** One builder per catalog row of section 6.9. */
export const REJECTIONS = {
  notYourTool(tool: string, role: string, denied?: { why?: string; alternative?: string }): HarnessRejection {
    return rejection(
      "not-your-tool",
      `${tool} is not available to a ${role} task, and nothing was done.`,
      denied?.why ?? "This role's tool list does not include it.",
      denied?.alternative ?? "Use the tools listed for your role.",
    );
  },

  spawnExecuteNeedsWorker(): HarnessRejection {
    return rejection(
      "spawn-execute-needs-worker",
      "Tier 1 spawn_task only permits research, plan, and verify; kind execute was rejected.",
      "Writes need a worktree and write leases, and only a Worker holds them.",
      "Use spawn_worker with write_scopes for implementation. spawn_task accepts research, plan, and verify here.",
    );
  },

  writeScopesRequired(): HarnessRejection {
    return rejection(
      "write-scopes-required",
      "spawn_worker was rejected: write_scopes is empty.",
      "Write scopes are the leases that keep parallel Workers from editing the same files.",
      "Pass the directories or globs this Worker will edit.",
    );
  },

  writeScopesBlanket(scopes: readonly string[] | string, branch: string): HarnessRejection {
    return rejection(
      "write-scopes-blanket",
      `spawn_worker was rejected: blanket write_scopes (${formatCompactList(scopes, 3)}) while another active run targets ${branch}.`,
      "A repo-wide lease would block that run's Workers.",
      "Pass module or directory globs instead.",
    );
  },

  draining(tool: string): HarnessRejection {
    return rejection(
      "draining",
      `${tool} was rejected: this task is draining for a rollover.`,
      "A child started now would be orphaned when the fresh session starts.",
      "Finish your handoff. The next generation can start the child.",
    );
  },

  settlementLiveChildren(ids: readonly string[] | string, count?: number): HarnessRejection {
    const n = count ?? (Array.isArray(ids) ? ids.length : 1);
    return rejection(
      "settlement-live-children",
      `return_task completed was rejected: ${n} child tasks are still active (${formatCompactList(ids, 4)}).`,
      "Completing now would orphan their work.",
      "Call wait_children, cancel_child for work you no longer need, or return_task with status blocked.",
    );
  },

  settlementDirtyWorktree(): HarnessRejection {
    return rejection(
      "settlement-dirty-worktree",
      "return_task completed was rejected: the worktree has uncommitted changes.",
      "Uncommitted work is lost when the worktree is removed.",
      "Commit, call submit_for_merge, then return_task. To hand back unfinished work, use status blocked or scope_too_large.",
    );
  },

  settlementUnmerged(detail: string, branch: string, opts?: { mergeInFlight?: boolean }): HarnessRejection {
    return rejection(
      "settlement-unmerged",
      `return_task completed was rejected: ${stripTrailingDot(compactWords(detail, 12))}.`,
      opts?.mergeInFlight
        ? `A merge into ${branch} is still in flight.`
        : `Completing now would leave your commits outside ${branch}.`,
      opts?.mergeInFlight
        ? "Wait for the existing merge to finish (check worktree_status), then call return_task, or return_task with status blocked."
        : `Call submit_for_merge for ${branch} changes, or return_task with external_deliverable {ref} when pushed elsewhere or a report, or status blocked.`,
    );
  },

  handoffSources(kind: string): HarnessRejection {
    return rejection(
      "handoff-sources",
      `return_task was rejected: a ${kind} handoff needs at least one source.`,
      "Your parent uses sources to check a read-only result without repeating your reads.",
      "Add sources with path and lines, or pass partial: true with artifact_paths.",
    );
  },

  escalationEvidence(tool: string): HarnessRejection {
    return rejection(
      "escalation-evidence",
      `${tool} was rejected: evidence_paths is empty.`,
      "The recipient needs a file or an artifact to act on the report.",
      "Pass at least one file path or artifact path.",
    );
  },

  readOnlyArgv(argv0: string, reason: string): HarnessRejection {
    return rejection(
      "read-only-argv",
      `inspect_command did not run ${argv0}: ${stripTrailingDot(compactWords(reason, 12))}.`,
      "This tool runs only read-only inspection commands, without a shell.",
      "Use a command from the tool description, or describe the needed command in return_task so your parent can assign it.",
    );
  },

  readOnlyShell(command: string): HarnessRejection {
    return rejection(
      "read-only-shell",
      `${compactWords(command, 8)} was not run.`,
      "This task is read-only, and the command is not on the read-only allowlist.",
      "Use inspect_command with an allowed read-only command, or describe the needed command in return_task so your parent can assign it.",
    );
  },

  readOnlyWrite(path: string): HarnessRejection {
    return rejection(
      "read-only-write",
      `The write to ${path} was denied.`,
      "This task has a read-only workspace.",
      "Describe the change in return_task. Your parent assigns it to a Worker.",
    );
  },

  protectedPath(path: string, root: string): HarnessRejection {
    return rejection(
      "protected-path",
      `${path} is protected.`,
      "Tasks may not touch .git or other tasks' worktrees, because they hold repository state and unmerged work.",
      `Work inside ${root}. For git state use git commands or inspect_command.`,
    );
  },

  outsideRoots(path: string, root: string): HarnessRejection {
    return rejection(
      "outside-roots",
      `${path} is outside the task workspace and its allowed roots.`,
      "Tasks read and write only inside their own roots.",
      `Use a path under ${root}. If the content lives elsewhere, ask your parent for it in return_task.`,
    );
  },

  readOnlyMcp(server: string, tool: string): HarnessRejection {
    return rejection(
      "read-only-mcp",
      `${server} ${tool} was not run.`,
      "This task is read-only, and that tool can change files or external state.",
      `Use the read-only tools of ${server}, or describe the needed change in return_task.`,
    );
  },

  toolPolicy(title: string, mode: string): HarnessRejection {
    return rejection(
      "tool-policy",
      `${compactWords(title, 6)} was not run.`,
      `It is outside this task's tool policy (${mode}).`,
      "Use the tools listed for your role, and put anything else you need in return_task.",
    );
  },

  writeScopeMerge(files: readonly string[] | string, scopes: readonly string[] | string): HarnessRejection {
    return rejection(
      "write-scope-merge",
      `The merge was rejected: ${formatCompactList(files, 3)} are outside your write scopes (${formatCompactList(scopes, 3)}).`,
      "Write scopes are leases, and another task may own these files.",
      "Revert those files and resubmit. If they must change, return_task with scope_too_large so your parent can widen the scope.",
    );
  },

  peerRoundCap(topic: string, n: number, run: string): HarnessRejection {
    return rejection(
      "peer-round-cap",
      `peer_request was rejected: topic ${topic} already used ${n} rounds with ${run}.`,
      "Bounded rounds keep two runs from waiting on each other forever.",
      "Send peer_notify, or publish the decision with contract_publish. If you are still blocked, call report_issue with severity P0.",
    );
  },

  submitDirtyWorktree(): HarnessRejection {
    return rejection(
      "submit-dirty-worktree",
      "submit_for_merge was rejected: the worktree has uncommitted changes.",
      "Only commits are merged, so uncommitted work would be left out.",
      "Commit the changes, then call submit_for_merge again.",
    );
  },

  artifactOutsideWorkspace(path: string): HarnessRejection {
    return rejection(
      "artifact-outside-workspace",
      `artifact_read cannot read ${path}.`,
      "It reads indexed artifacts and files inside your task workspace only.",
      "Use your file-read tool for other workspace files, or pass task_id to read a child's artifact.",
    );
  },

  inspectCwd(cwd: string): HarnessRejection {
    return rejection(
      "inspect-cwd",
      `inspect_command cwd ${cwd} was rejected.`,
      "The directory must be an unprotected directory inside your task workspace.",
      "Pass a workspace-relative directory, or omit cwd to use the workspace root.",
    );
  },

  directorProtectedRead(path: string): HarnessRejection {
    return rejection(
      "director-protected-read",
      `read_file cannot read ${path}.`,
      ".git internals, task worktrees, and harness state are protected, because they hold other tasks' unmerged work.",
      "Use run_status, goal_get, or artifact_read. For git history, spawn_task a research task.",
    );
  },

  directorNoteRoot(path: string): HarnessRejection {
    return rejection(
      "director-note-root",
      `write_note cannot write ${path}.`,
      "The Director only writes notes under allowed note roots, never tracked source.",
      storageText().directorNoteRootAlternative(),
    );
  },

  dossierInvalidDirectory(path: string): HarnessRejection {
    return rejection(
      "dossier-invalid-directory",
      `ENOTDIR: expected a non-symlink artifact directory at ${path}.`,
      storageText().dossierInvalidDirectoryReason(),
      `Remove or rename the conflicting file or symlink at ${path}, or use a clean artifact directory.`,
    );
  },

  dossierSymlink(path: string): HarnessRejection {
    return rejection(
      "dossier-symlink",
      storageText().dossierSymlinkWhat(path),
      "Symlinks and redirected paths cannot be confined to this run's dossier tree.",
      "Call artifact_read with no path to list regular indexed dossiers of this run, then read one of those paths.",
    );
  },

  dossierNotIndexed(path: string): HarnessRejection {
    return rejection(
      "dossier-not-indexed",
      `No indexed dossier in this run at ${path}.`,
      "artifact_read only opens dossiers indexed for the current run, never unindexed files or another run's dossiers.",
      "Call artifact_read with no path or task_id to list indexed dossiers of this run, then read one of those paths.",
    );
  },

  dossierAmbiguousOwner(path: string): HarnessRejection {
    return rejection(
      "dossier-ambiguous-owner",
      `Dossier path has ambiguous multi-run ownership: ${path}.`,
      "A path indexed by multiple runs cannot prove which run's bytes it currently holds.",
      "Call artifact_read with no path to pick a regular dossier indexed only by this run, or write a new dossier with artifact_write.",
    );
  },

  codeExecTimeout(seconds: number, maxSeconds: number): HarnessRejection {
    return rejection(
      "code-exec-timeout",
      `code_exec stopped after ${seconds} seconds.`,
      "Scripts have a time cap so a hung script cannot hold the task.",
      `Split the work into smaller scripts, or pass a larger timeout_s, up to ${maxSeconds}.`,
    );
  },

  codeExecIpc(): HarnessRejection {
    return rejection(
      "code-exec-ipc",
      "code_exec stopped: one tool result exceeded 16 MiB.",
      "Results travel over a bounded channel between the script and the harness.",
      "Page the read with offset and max_chars, or filter inside the script before returning.",
    );
  },

  pythonPackages(n: number): HarnessRejection {
    return rejection(
      "python-packages",
      `code_exec was rejected: ${n} packages requested, and at most 32 are allowed.`,
      "Each package is downloaded and verified before the script runs.",
      "Request only the packages this script imports.",
    );
  },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function firstString(obj: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Notice for a runner denial reported on a tool event. Unknown ids map to "tool-policy". */
export function deniedNotice(
  ev: { denied: string; name: string; args?: unknown; paths?: string[] },
  ctx: { workspaceRoot: string },
): Notice {
  const args = asRecord(ev.args);
  const targetPath =
    ev.paths?.[0] ??
    firstString(args, ["path", "file_path", "filePath", "target_file", "notebook_path", "destination", "new_path"]) ??
    ev.name;

  switch (ev.denied) {
    case "read-only-shell": {
      const cmd = firstString(args, ["command", "cmd", "script"]) ?? ev.name;
      return REJECTIONS.readOnlyShell(cmd).notice;
    }
    case "read-only-write":
      return REJECTIONS.readOnlyWrite(targetPath).notice;
    case "protected-path":
      return REJECTIONS.protectedPath(targetPath, ctx.workspaceRoot).notice;
    case "outside-roots":
      return REJECTIONS.outsideRoots(targetPath, ctx.workspaceRoot).notice;
    case "read-only-mcp": {
      const server = firstString(args, ["server"]) ?? "MCP";
      const tool = firstString(args, ["tool"]) ?? ev.name;
      return REJECTIONS.readOnlyMcp(server, tool).notice;
    }
    case "tool-policy":
    default: {
      const mode = firstString(args, ["mode"]) ?? "restricted";
      return REJECTIONS.toolPolicy(ev.name, mode).notice;
    }
  }
}
