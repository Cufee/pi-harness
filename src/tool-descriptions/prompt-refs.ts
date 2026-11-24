import type { Role } from "../advisories/types.js";
import { allToolNames, allowedToolNames } from "./registry.js";

export type MentionHolder = "parent" | "child" | "harness";

const recordedPromptMentions = new Map<Role, Map<string, { tool: string; as: MentionHolder }>>();

/** Returns the tool name in backticks. Throws if the role's registry set lacks the tool. */
export function toolRef(role: Role, name: string): string {
  if (!allowedToolNames(role).has(name)) {
    throw new Error(`toolRef: tool "${name}" is not available to role "${role}"`);
  }
  return `\`${name}\``;
}

/**
 * Names a tool the role cannot call, in someone else's hands ("your parent reads it with `wait_children`").
 * Throws if the tool is not in the registry. Records the allowance for the role-separation test.
 */
export function mentionRef(role: Role, name: string, as: MentionHolder): string {
  if (!allToolNames().has(name)) {
    throw new Error(`mentionRef: unknown registry tool "${name}"`);
  }
  if (allowedToolNames(role).has(name)) {
    throw new Error(`mentionRef: role "${role}" already owns "${name}"; use toolRef instead`);
  }
  let perRole = recordedPromptMentions.get(role);
  if (!perRole) {
    perRole = new Map();
    recordedPromptMentions.set(role, perRole);
  }
  const key = `${name}:${as}`;
  if (!perRole.has(key)) {
    perRole.set(key, { tool: name, as });
  }
  return `\`${name}\``;
}

export function promptMentions(role: Role): ReadonlyArray<{ tool: string; as: string }> {
  const perRole = recordedPromptMentions.get(role);
  if (!perRole) return [];
  return [...perRole.values()];
}
