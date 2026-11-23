import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { chooseRemoteProject, parseArgs, probeHostSwitchClient, resolveLocalStartup } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { findProjectContainingPath, type ProjectSummary } from "../src/control-plane/projects.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { createTheme, ModalScreen, Navigator, stripTerminalSequences } from "../src/tui/core/index.js";
import { type FederatedProjectSummary, pickProjectTui, ProjectsScreen } from "../src/tui/projects.js";

function makeFakeTerminal(cols = 100, rows = 30) {
  let onDataCb: ((data: string) => void) | null = null;
  const terminal: Terminal = {
    columns: cols,
    rows,
    kittyProtocolActive: false,
    start(onData) {
      onDataCb = onData;
    },
    stop() {
      onDataCb = null;
    },
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
  return {
    terminal,
    sendInput: (data: string) => onDataCb?.(data),
  };
}

function makeMockClient(): DaemonClient {
  const closeListeners = new Set<() => void>();
  return {
    async request<T = unknown>(): Promise<T> {
      return [] as unknown as T;
    },
    onEvent() {
      return () => {};
    },
    onClose(fn: () => void) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    close() {
      for (const fn of closeListeners) fn();
    },
  } as unknown as DaemonClient;
}

describe("CLI startup project picker and --resume", () => {
  it("parses --resume as a boolean flag without consuming positionals", () => {
    const bare = parseArgs(["--resume"]);
    assert.equal(bare.flags.resume, true);
    assert.deepEqual(bare.positional, []);

    const beforeChat = parseArgs(["--resume", "chat"]);
    assert.equal(beforeChat.flags.resume, true);
    assert.deepEqual(beforeChat.positional, ["chat"]);

    const withProject = parseArgs(["chat", "--resume", "-p", "web"]);
    assert.equal(withProject.flags.resume, true);
    assert.equal(withProject.flags.p, "web");
    assert.deepEqual(withProject.positional, ["chat"]);
  });

  it("finds the deepest registered project containing a canonical path", () => {
    const projects = [
      { id: "proj-1", rootPath: "/w/mono" },
      { id: "proj-2", rootPath: "/w/mono/packages/app" },
      { id: "proj-3", rootPath: "/w/mono-other" },
    ];

    assert.equal(findProjectContainingPath(projects, "/w/mono")?.id, "proj-1");
    assert.equal(findProjectContainingPath(projects, "/w/mono/packages/app/src/x")?.id, "proj-2");
    assert.equal(findProjectContainingPath(projects, "/w/mono/packages/lib")?.id, "proj-1");
    assert.equal(findProjectContainingPath(projects, "/w/mono-other2"), null);
    assert.equal(findProjectContainingPath(projects, "/w"), null);
    assert.equal(findProjectContainingPath(projects, "/w/mono/..cache")?.id, "proj-1");
    assert.equal(findProjectContainingPath([], "/w/mono"), null);
  });

  it("resolves local startup across picker default, --resume, -p, and --repo", () => {
    const projects = [
      { id: "proj-1", rootPath: "/w/mono" },
      { id: "proj-2", rootPath: "/w/mono/packages/app" },
    ];

    const plain = resolveLocalStartup({ cwd: "/w/mono/packages/app", resume: false, projects });
    assert.deepEqual(plain, { kind: "picker" });

    const resumed = resolveLocalStartup({ cwd: "/w/mono/packages/app/src", resume: true, projects });
    assert.deepEqual(resumed, { kind: "chat", projectId: "proj-2", repoRoot: "/w/mono/packages/app" });

    const noMatch = resolveLocalStartup({ cwd: "/tmp/unregistered", resume: true, projects });
    assert.equal(noMatch.kind, "picker");
    if (noMatch.kind !== "picker") assert.fail("expected picker start");
    assert.equal(noMatch.notice?.tone, "warn");
    assert.ok(noMatch.notice?.text.includes("/tmp/unregistered"));

    const explicitProject = resolveLocalStartup({
      cwd: "/w/mono/packages/app",
      projectFlag: "web",
      resume: true,
      projects,
    });
    assert.deepEqual(explicitProject, { kind: "chat", projectId: "web" });

    const explicitRepo = resolveLocalStartup({
      cwd: "/w/mono/packages/app",
      explicitRepoRoot: "/w/other",
      resume: true,
      projects,
    });
    assert.deepEqual(explicitRepo, { kind: "chat", repoRoot: "/w/other" });
  });

  it("matches a subdirectory against real daemon project.list and reopens the same chat session", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-startup-"));
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");
    const projDir = join(root, "app");
    const subDir = join(projDir, "packages", "web");
    mkdirSync(subDir, { recursive: true });

    const cfg = loadConfig(root);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg);
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const created = await client.request<ProjectSummary>("project.create", {
        path: projDir,
        name: "app",
        createDir: false,
      });
      const listed = await client.request<ProjectSummary[]>("project.list", { includeRemotes: false });
      const matched = findProjectContainingPath(listed, realpathSync(subDir));
      assert.equal(matched?.id, created.id);
      assert.equal(matched?.rootPath, created.rootPath);

      const first = await client.request<{ session: { id: string } }>("chat.open", { projectId: matched!.id });
      const second = await client.request<{ session: { id: string } }>("chat.open", { projectId: matched!.id });
      assert.equal(second.session.id, first.session.id);
    } finally {
      client.close();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders initialNotice in ProjectsScreen and resolves pickProjectTui on Enter or Esc", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const client = makeMockClient();

    const { terminal: screenTerminal } = makeFakeTerminal();
    const tui = new ModalScreen(screenTerminal);
    const nav = new Navigator(tui, screenTerminal, theme);
    const noticeText = "--resume: no registered project contains /tmp/nowhere. Pick a project, or press n to add one.";
    const screen = new ProjectsScreen(client, {
      initialProjects: [],
      initialNotice: { tone: "warn", text: noticeText },
      onOpenProject: () => {},
    });
    nav.push(screen);
    const rendered = screen.render(120, 20, theme).map(stripTerminalSequences).join("\n");
    assert.ok(rendered.includes("--resume: no registered project contains /tmp/nowhere"));

    const row: FederatedProjectSummary = {
      id: "proj-1",
      name: "alpha",
      rootPath: "/w/alpha",
      description: null,
      defaultProfileId: null,
      defaultModel: null,
      defaultEffort: null,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
      exists: true,
      isGit: true,
      gitBranch: "main",
      sessionCount: 1,
      activeGoalCount: 0,
      activeRunCount: 0,
      host: "local",
    };

    const enterTerm = makeFakeTerminal();
    const enterPromise = pickProjectTui({ client, initialProjects: [row], terminal: enterTerm.terminal });
    enterTerm.sendInput("\r");
    const chosen = await enterPromise;
    assert.equal(chosen?.id, "proj-1");

    const escTerm = makeFakeTerminal();
    const escPromise = pickProjectTui({ client, initialProjects: [row], terminal: escTerm.terminal });
    escTerm.sendInput("\x1b");
    const cancelled = await escPromise;
    assert.equal(cancelled, null);
  });

  it("shows the empty picker for an empty remote project list and tracks picker liveness in daemon TUI sockets", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-startup-remote-"));
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(root);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg);
    await daemon.start();
    const pickerClient = new DaemonClient(sockPath);
    const chatClient = new DaemonClient(sockPath);
    await pickerClient.connect();
    await chatClient.connect();

    try {
      // Open a chat on chatClient, then open the remote picker on pickerClient with 0 projects
      await chatClient.request("chat.open", { repoRoot: root });
      const remoteProjectsBefore = await pickerClient.request<ProjectSummary[]>("project.list", { includeRemotes: false });
      assert.equal(remoteProjectsBefore.length, 1); // chat.open auto-registered root

      // Remove project so remote project list is genuinely empty
      await pickerClient.request("project.remove", { projectId: remoteProjectsBefore[0]!.id });
      const emptyList = await pickerClient.request<ProjectSummary[]>("project.list", { includeRemotes: false });
      assert.equal(emptyList.length, 0);

      // chooseRemoteProject must show the picker (not return preferLastProject chat start) and register TUI liveness
      const pickerTerm = makeFakeTerminal();
      const pickPromise = chooseRemoteProject(pickerClient, "gpu-box", { terminal: pickerTerm.terminal });
      await new Promise((r) => setTimeout(r, 40));

      // Leaving the only attached chat while picker is open must still report running === true (picker is live!)
      const chatLeave = await chatClient.request<{ running: boolean }>("session.leave");
      assert.equal(chatLeave.running, true, "open picker must keep daemon live when last chat leaves");

      // Cancelling the empty picker resolves to null (never auto-opens daemon cwd), and releasing leaves daemon idle
      pickerTerm.sendInput("\x1b");
      const picked = await pickPromise;
      assert.equal(picked, null);

      const pickerLeave = await pickerClient.request<{ running: boolean }>("session.leave");
      assert.equal(pickerLeave.running, false, "cancelling lone picker must release TUI liveness");
    } finally {
      pickerClient.close();
      chatClient.close();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes a failed host-switch probe on nodeId mismatch without sending session.leave", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-startup-mismatch-"));
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(root);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg);
    await daemon.start();
    const sentOps: string[] = [];
    let closed = false;

    try {
      await assert.rejects(
        () =>
          probeHostSwitchClient({
            connect: async () => {
              const raw = new DaemonClient(sockPath);
              await raw.connect();
              const origRequest = raw.request.bind(raw);
              const origClose = raw.close.bind(raw);
              raw.request = (<T = unknown>(op: Parameters<typeof origRequest>[0], params?: Record<string, unknown>) => {
                sentOps.push(op);
                return origRequest<T>(op, params);
              }) as typeof raw.request;
              raw.close = () => {
                closed = true;
                origClose();
              };
              return raw;
            },
            targetHostLabel: "gpu-box",
            expectedNodeId: "expected-other-node",
          }),
        /alias mismatch/,
      );

      assert.deepEqual(sentOps, ["ping"]);
      assert.equal(closed, true);

      // Daemon remains reachable after failed unregistered probe closes
      const verify = new DaemonClient(sockPath);
      await verify.connect();
      try {
        const pong = await verify.request<{ pong: boolean }>("ping");
        assert.equal(pong.pong, true);
      } finally {
        verify.close();
      }
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
