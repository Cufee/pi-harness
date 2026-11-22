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
  { name: "work", usage: "/work [tab]", description: "Open Work Navigator (Ctrl+G) — Inbox, Goals, Runs, Escalations, Timers, Worktrees", modes: ["chat", "run"] },
  { name: "inbox", usage: "/inbox", description: "Jump straight to Inbox (open escalations, awaiting_human goals, blockers)", modes: ["chat", "run"] },
  { name: "escalations", aliases: ["esc"], usage: "/escalations", description: "Open Escalations tab to inspect, acknowledge, or resolve escalations", modes: ["chat", "run"] },
  { name: "goals", usage: "/goals", description: "Open Goals tab in Work Navigator", modes: ["chat", "run"] },
  { name: "runs", usage: "/runs", description: "Open Runs tab in Work Navigator", modes: ["chat", "run"] },
  { name: "timers", usage: "/timers", description: "Open scheduled Timers tab", modes: ["chat", "run"] },
  { name: "worktrees", usage: "/worktrees", description: "Inspect or sweep Worktrees & Merge Queue", modes: ["chat", "run"] },
  { name: "stop", usage: "/stop [reason]", description: "Stop ALL active runs and running agents across the harness", modes: ["chat", "run"] },
  { name: "model", usage: "/model", description: "Open Model & Effort picker", modes: ["chat"] },
  { name: "effort", usage: "/effort [level]", description: "Set reasoning effort or open Model & Effort picker", modes: ["chat"] },
  { name: "quota", usage: "/quota", description: "Open Quota & Cost viewer", modes: ["chat", "run"] },
  { name: "cost", usage: "/cost", description: "Open Cost & Quota viewer", modes: ["chat", "run"] },
  { name: "kb", usage: "/kb", description: "Browse repository Knowledge Base", modes: ["chat", "run"] },
  { name: "sessions", usage: "/sessions", description: "Switch between chat sessions and live runs", modes: ["chat", "run"] },
  { name: "new", usage: "/new [title]", description: "Start a new Director chat session", modes: ["chat"] },
  { name: "settings", usage: "/settings", description: "Edit default harness profiles and worker limits", modes: ["chat", "run"] },
  { name: "status", usage: "/status", description: "Print concise summary of active goals, escalations, and runs", modes: ["chat", "run"] },
  { name: "resume", usage: "/resume [in <dur> | msg]", description: "Resume paused run now or schedule delayed resume (e.g. /resume in 15m)", modes: ["run"] },
  { name: "steer", usage: "/steer <task-id> <msg>", description: "Steer a specific running task", modes: ["chat", "run"] },
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
  { key: "Ctrl+G", description: "Open Work Navigator (Inbox / Goals / Runs / Escalations / Timers / Worktrees)" },
  { key: "Ctrl+O", description: "Go-To-Anything fuzzy palette (jump to any entity or command)" },
  { key: "Ctrl+X", description: "Inspect latest surfaced receipt, escalation, goal, or tool call" },
  { key: "Alt+1..5", description: "Jump straight into numbered attention slot in top dock row" },
  { key: "Ctrl+U / Ctrl+K / Ctrl+W", description: "Clear line before cursor / to end / previous word" },
  { key: "Ctrl+Z / Ctrl+-", description: "Undo composer edit" },
  { key: "Shift+Enter", description: "Insert newline in composer" },
  { key: "Ctrl+C / Ctrl+]", description: "Cancel active turn (press twice to detach) / immediate detach" },
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
