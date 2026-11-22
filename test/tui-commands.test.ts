import { describe, expect, test } from "bun:test";
import {
  autocompleteCommands,
  COMMANDS,
  commandsFor,
  completions,
  paletteCommands,
  renderHelp,
  resolveCommand,
} from "../src/tui/commands.js";

const CHAT = ["runs", "goals", "sessions", "new", "model", "effort", "quota", "worktrees", "kb", "settings", "status", "clear", "help", "quit"];
const RUN = ["runs", "sessions", "stop", "help", "quit"];
const REMOVED = ["models", "attach", "cli", "acp", "profile", "profiles", "review", "resume", "tree", "detach", "q", "exit"];

describe("slash command registry", () => {
  test("each mode exposes exactly its canonical commands, without duplicates", () => {
    expect(commandsFor("chat").map((c) => c.name)).toEqual(CHAT);
    expect(commandsFor("run").map((c) => c.name)).toEqual(RUN);
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("removed aliases and mode-foreign commands resolve to null", () => {
    for (const mode of ["chat", "run"] as const) {
      for (const name of REMOVED) expect(resolveCommand(mode, `/${name}`)).toBeNull();
    }
    expect(resolveCommand("chat", "/stop")).toBeNull();
    expect(resolveCommand("run", "/model")).toBeNull();
    expect(resolveCommand("run", "/goals")).toBeNull();
    // Exact names only: no prefix matching.
    expect(resolveCommand("chat", "/run")).toBeNull();
    expect(resolveCommand("chat", "runs")).toBeNull();
  });

  test("resolveCommand splits the argument", () => {
    expect(resolveCommand("chat", "/kb  quota rules ")).toMatchObject({ cmd: { name: "kb" }, arg: "quota rules" });
    expect(resolveCommand("run", "/sessions run-42")).toMatchObject({ cmd: { name: "sessions" }, arg: "run-42" });
    expect(resolveCommand("run", "/stop")).toMatchObject({ cmd: { name: "stop" }, arg: "" });
  });

  test("key annotations: /runs is Ctrl+T and /quit is Ctrl+] in run mode", () => {
    const run = commandsFor("run");
    expect(run.find((c) => c.name === "runs")?.key).toBe("Ctrl+T");
    expect(run.find((c) => c.name === "quit")?.key).toBe("Ctrl+]");
  });

  test("help, palette and completions are derived from the registry", () => {
    for (const mode of ["chat", "run"] as const) {
      const cmds = commandsFor(mode);
      const help = renderHelp(mode).join("\n");
      for (const c of cmds) {
        expect(help).toContain(`/${c.name}`);
        if (c.key) expect(help).toContain(c.key);
      }
      for (const name of REMOVED) expect(help).not.toMatch(new RegExp(`/${name}\\b`));

      const ran: string[] = [];
      const palette = paletteCommands(mode, (c) => ran.push(c.name));
      expect(palette.map((p) => p.label)).toEqual(cmds.map((c) => `/${c.name}`));
      palette.forEach((p) => p.run());
      expect(ran).toEqual(cmds.map((c) => c.name));

      expect(autocompleteCommands(mode).map((c) => c.name)).toEqual(cmds.map((c) => c.name));
      expect(completions(mode, "").map((c) => c.name)).toEqual(cmds.map((c) => c.name));
    }
    expect(completions("chat", "/s").map((c) => c.name)).toEqual(["sessions", "settings", "status"]);
    expect(completions("run", "s").map((c) => c.name)).toEqual(["sessions", "stop"]);
    expect(palette("run").find((p) => p.label === "/runs")?.shortcut).toBe("Ctrl+T");
  });
});

function palette(mode: "chat" | "run") {
  return paletteCommands(mode, () => {});
}
