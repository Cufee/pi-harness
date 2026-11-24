import type { TaskRecord } from "../control-plane/db.js";
import { isDirectorTaskContainer } from "../control-plane/ids.js";
import type { Role } from "./types.js";

/** Done-Reviewer: a Tier 3 verify task whose title starts "Done-Review:". */
export function isDoneReviewTask(task: Pick<TaskRecord, "tier" | "kind" | "title">): boolean {
  return task.tier === 3 && task.kind === "verify" && task.title.startsWith("Done-Review:");
}

/**
 * director: the synthetic owner of a Director bucket (tier 1, profileId "director", container run).
 * reviewer: a Done-Review task.
 * Otherwise tier 1 -> orchestrator, tier 2 -> worker, tier 3 -> its kind.
 */
export function roleOf(task: Pick<TaskRecord, "runId" | "tier" | "kind" | "profileId" | "title">): Role {
  if (task.tier === 1 && task.profileId === "director" && isDirectorTaskContainer(task.runId)) {
    return "director";
  }
  if (isDoneReviewTask(task)) {
    return "reviewer";
  }
  if (task.tier === 1) return "orchestrator";
  if (task.tier === 2) return "worker";
  return task.kind;
}
