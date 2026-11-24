import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { fit } from "./core/index.js";

export type TuiMode = "chat" | "run";

export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  modes: TuiMode[];
}

export const COMMAND_SPECS: CommandSpec[] = [
  { name: "projects", aliases: ["project", "proj"], usage: "/projects [name|add <path>|switch <name>]", description: "Manage, create, browse, or switch local & remote projects (Ctrl+P)", modes: ["chat", "run"] },
  { name: "remotes", aliases: ["remote", "hosts"], usage: "/remotes [add <name> <ssh> | connect <name>]", description: "Manage remote SSH peer hosts and switch active host", modes: ["chat", "run"] },
  { name: "send", usage: "/send <host:chat|chat-id> <message>", description: "Send a peer message to any local or remote session (wakes recipient)", modes: ["chat"] },
  { name: "work", usage: "/work [tab]", description: "Open Work Navigator (Ctrl+G) — Inbox, Goals, Escalations (Runs, Timers, Worktrees with /internal)", modes: ["chat", "run"] },
  { name: "inbox", usage: "/inbox", description: "Jump straight to Inbox (open escalations, awaiting_human goals, blockers)", modes: ["chat", "run"] },
  { name: "escalations", aliases: ["esc"], usage: "/escalations", description: "Open Escalations tab to inspect, acknowledge, or resolve escalations", modes: ["chat", "run"] },
  { name: "goals", usage: "/goals", description: "Open Goals tab in Work Navigator", modes: ["chat", "run"] },
  { name: "runs", usage: "/runs", description: "Open Runs tab in Work Navigator (Ctrl+T)", modes: ["chat", "run"] },
  { name: "timers", usage: "/timers", description: "Open scheduled Timers tab", modes: ["chat", "run"] },
  { name: "worktrees", usage: "/worktrees", description: "Inspect or sweep Worktrees & Merge Queue", modes: ["chat", "run"] },
  { name: "stop", usage: "/stop [reason]", description: "Stop ALL active runs and running agents across the harness", modes: ["chat", "run"] },
  { name: "model", usage: "/model", description: "Open Model Picker & Enable/Disable Models", modes: ["chat"] },
  { name: "effort", usage: "/effort [level]", description: "Set reasoning effort or open Effort picker", modes: ["chat"] },
  { name: "quota", usage: "/quota", description: "Open Quota Capacity & Reported Spend dashboard", modes: ["chat", "run"] },
  { name: "cost", usage: "/cost", description: "Open Reported Spend & Quota dashboard", modes: ["chat", "run"] },
  { name: "kb", usage: "/kb [query]", description: "Browse or search repository Knowledge Base", modes: ["chat", "run"] },
  { name: "sessions", usage: "/sessions [id]", description: "Switch between chat sessions and live runs", modes: ["chat", "run"] },
  { name: "take", aliases: ["control", "reclaim"], usage: "/take", description: "Take input control of this session back from another terminal (Ctrl+Y)", modes: ["chat", "run"] },
  { name: "new", usage: "/new [title]", description: "Start a new Director chat session", modes: ["chat"] },
  { name: "settings", usage: "/settings", description: "Manage ACP CLIs, Enabled Models & Runtime Defaults (Ctrl+,)", modes: ["chat", "run"] },
  { name: "status", usage: "/status", description: "Print daemon status, active model/CLIs, and active goals/escalations", modes: ["chat", "run"] },
  { name: "resume", usage: "/resume [in <dur> | msg]", description: "Resume paused run now or schedule delayed resume (e.g. /resume in 15m)", modes: ["run"] },
  { name: "steer", usage: "/steer <task-id> <msg>", description: "Steer a specific running task", modes: ["chat", "run"] },
  { name: "now", usage: "/now [n]", description: "Steer a queued message into the live turn now (default: 1, or Alt+S)", modes: ["chat"] },
  { name: "queue", usage: "/queue", description: "List all queued, sending, and unconfirmed messages with position and state", modes: ["chat", "run"] },
  { name: "drop", aliases: ["unqueue"], usage: "/drop [n|all]", description: "Drop a queued message without sending it (default: latest)", modes: ["chat", "run"] },
  { name: "internal", usage: "/internal", description: "Toggle internal details: chat lines, Runs/Timers/Worktrees tabs, full dock breakdown", modes: ["chat", "run"] },
  { name: "clear", usage: "/clear", description: "Clear the local transcript view", modes: ["chat", "run"] },
  { name: "help", aliases: ["?"], usage: "/help", description: "Show commands and keyboard shortcuts", modes: ["chat", "run"] },
  { name: "quit", aliases: ["exit", "detach"], usage: "/quit", description: "Detach from TUI (daemon and background runs keep running)", modes: ["chat", "run"] },
];

export interface ParsedSlashCommand {
  name: string;
  args: string;
  raw: string;
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const rawName = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();
  const canonical = COMMAND_SPECS.find((c) => c.name === rawName || c.aliases?.includes(rawName))?.name ?? rawName;
  return { name: canonical, args, raw: trimmed };
}

export function createCommandAutocomplete(mode: TuiMode): CombinedAutocompleteProvider {
  const cmds: SlashCommand[] = COMMAND_SPECS.filter((c) => c.modes.includes(mode)).map((c) => ({
    name: c.name,
    description: c.description,
  }));
  return new CombinedAutocompleteProvider(cmds, process.cwd());
}

export const KEYBOARD_SHORTCUTS: ReadonlyArray<{ key: string; description: string }> = [
  { key: "Ctrl+P", description: "Open Projects manager/picker (select, create, clone, browse, switch session)" },
  { key: "Ctrl+G", description: "Open Work Navigator (Inbox / Goals / Escalations; i shows internal tabs)" },
  { key: "Ctrl+T", description: "Open Runs tab directly in Work Navigator" },
  { key: "Ctrl+O", description: "Go-To-Anything fuzzy palette (pinned commands, inbox blockers, entities)" },
  { key: "Ctrl+,", description: "Open Settings (ACP CLIs, Enabled Models, Runtime Defaults)" },
  { key: "Ctrl+X", description: "Inspect latest surfaced receipt, escalation, goal, or tool call" },
  { key: "Ctrl+Y", description: "Take control when this terminal is read-only" },
  { key: "Alt+1..5", description: "Jump straight into numbered attention slot in dock" },
  { key: "Ctrl+Q / Alt+Enter", description: "Queue follow-up message while busy or offline (busy Enter also queues)" },
  { key: "Alt+S", description: "Steer first queued message into the live turn now (or /now [n])" },
  { key: "Ctrl+R", description: "Recall latest queued draft back into composer" },
  { key: "Alt+Q", description: "Drop latest queued message without sending it (or /drop [n|all])" },
  { key: "Ctrl+Z / Ctrl+-", description: "Undo composer edit" },
  { key: "Shift+Enter", description: "Insert newline in composer" },
  { key: "Esc Esc", description: "Confirm & cancel active turn" },
  { key: "Ctrl+C / Ctrl+D / Ctrl+]", description: "Clear draft or cancel (2x exits) / exit on empty idle / instant detach" },
];

export function renderHelp(mode: TuiMode): string[] {
  const cmds = COMMAND_SPECS.filter((c) => c.modes.includes(mode));
  const colW =
    Math.max(
      ...cmds.map((c) => c.usage.length),
      ...KEYBOARD_SHORTCUTS.map((s) => s.key.length),
    ) + 2;

  const lines: string[] = [
    `Commands (${mode} mode):`,
    ...cmds.map((c) => `  ${fit(c.usage, colW)}${c.description}`),
    "",
    "Shortcuts:",
    ...KEYBOARD_SHORTCUTS.map((s) => `  ${fit(s.key, colW)}${s.description}`),
  ];
  return lines;
}
