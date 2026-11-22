import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import type { ProjectBrowseResult, ProjectSummary } from "../src/control-plane/projects.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { DAEMON_PROTOCOL_REV, HarnessDaemon } from "../src/daemon/server.js";
import { createTheme, ModalScreen, Navigator, stripTerminalSequences, visibleWidth } from "../src/tui/core/index.js";
import { ProjectsScreen } from "../src/tui/projects.js";
import type { AttachableSession } from "../src/tui/store.js";

function makeFakeTerminal(): Terminal {
  return {
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    start() {},
    stop() {},
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
}

describe("SSH-first Projects Registry, Session Switching, Non-Git Folders & TUI Picker", () => {
  it("creates git & plain-folder projects, binds sessions, switches session projects in-place, and renders ProjectsScreen width-safely", async () => {
    assert.equal(DAEMON_PROTOCOL_REV, 7);
    const root = realpathSync(mkdtempSync("/tmp/pi-proj-"));
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");
    const workspacesDir = join(root, "workspaces");
    const gitProjPath = join(workspacesDir, "backend");
    const folderProjPath = join(workspacesDir, "scratch-notes");

    const cfg = loadConfig(root);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg);
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      // 1. Create a git-initialized project and a plain non-git folder project via daemon RPCs
      const pGit = await client.request<ProjectSummary>("project.create", {
        path: gitProjPath,
        name: "backend",
        gitInit: true,
        createDir: true,
      });
      assert.equal(pGit.id, "proj-1");
      assert.equal(pGit.name, "backend");
      assert.equal(pGit.exists, true);
      assert.equal(pGit.isGit, true);

      const pFolder = await client.request<ProjectSummary>("project.create", {
        path: folderProjPath,
        name: "notes",
        createDir: true,
      });
      assert.equal(pFolder.id, "proj-2");
      assert.equal(pFolder.name, "notes");
      assert.equal(pFolder.exists, true);
      assert.equal(pFolder.isGit, false);
      assert.equal(pFolder.gitBranch, null);
      writeFileSync(join(folderProjPath, "todo.md"), "# Notes\n");

      // Non-git folder gracefully resolves repo info without crashing
      const nonGitInfo = await daemon.orchestrator.getWorktreeManager(folderProjPath).resolveRepoInfo();
      assert.deepEqual(nonGitInfo, { baseBranch: "workspace", baseSha: "none" });

      // 2. Remote directory browse returns git repos first
      const browsed = await client.request<ProjectBrowseResult>("project.browse", { path: workspacesDir });
      assert.equal(browsed.path, workspacesDir);
      assert.equal(browsed.entries[0]?.name, "backend");
      assert.equal(browsed.entries[0]?.isGit, true);
      assert.equal(browsed.entries[1]?.name, "scratch-notes");
      assert.equal(browsed.entries[1]?.isGit, false);

      // 3. SSH-style open (`preferLastProject: true`, no repoRoot) opens the most recently used project ("notes")
      const openedRemote = await client.request<{
        session: { id: string; projectId: string | null; repoRoot: string };
        project: { id: string; name: string } | null;
      }>("chat.open", { preferLastProject: true });
      assert.equal(openedRemote.project?.id, pFolder.id);
      assert.equal(openedRemote.session.projectId, pFolder.id);
      assert.equal(openedRemote.session.repoRoot, pFolder.rootPath);

      // Add a goal in `notes` and another goal in `backend` for cross-project verification
      daemon.director.goals.createGoal({
        repoRoot: pFolder.rootPath,
        chatSessionId: openedRemote.session.id,
        title: "Organize research notes",
        description: "Plain folder goal",
        criteria: [],
        verificationMode: "none",
      });
      daemon.director.goals.createGoal({
        repoRoot: pGit.rootPath,
        chatSessionId: null,
        title: "Ship API endpoint",
        description: "Git repo goal",
        criteria: [],
        verificationMode: "none",
      });

      // Cross-project goal_list works cleanly when all_projects: true
      const scopedGoals = (await daemon.director.executeDirectorMcpTool(openedRemote.session.id, "goal_list", {})) as {
        goals: Array<{ title: string }>;
      };
      assert.equal(scopedGoals.goals.length, 1);
      const allGoals = (await daemon.director.executeDirectorMcpTool(openedRemote.session.id, "goal_list", {
        all_projects: true,
      })) as { goals: Array<{ title: string }> };
      assert.equal(allGoals.goals.length, 2);

      // 4. Switch the SAME chat session into `backend` in-place via `chat.set_project` (preserving session ID & history)
      const switched = await client.request<{
        session: { id: string; projectId: string | null; repoRoot: string; acpSessionId: string | null };
        project: { id: string; name: string };
      }>("chat.set_project", { chatSessionId: openedRemote.session.id, projectId: "backend" });
      assert.equal(switched.session.id, openedRemote.session.id);
      assert.equal(switched.session.projectId, pGit.id);
      assert.equal(switched.session.repoRoot, pGit.rootPath);
      assert.equal(switched.session.acpSessionId, null);

      // Director `project_list` & `project_switch` MCP tools work directly too
      const listedFromDirector = (await daemon.director.executeDirectorMcpTool(openedRemote.session.id, "project_list", {})) as {
        currentProjectId: string;
        projects: ProjectSummary[];
      };
      assert.equal(listedFromDirector.currentProjectId, pGit.id);
      assert.equal(listedFromDirector.projects.length, 2);

      // sessions.list exposes projectId and projectName
      const sessions = await client.request<AttachableSession[]>("sessions.list");
      const chatEntry = sessions.find((s) => s.id === openedRemote.session.id);
      assert.equal(chatEntry?.projectId, pGit.id);
      assert.equal(chatEntry?.projectName, "backend");

      // 5. ProjectsScreen TUI renders aligned columns width-safely across 60/80/120 cols and supports Enter + 's'
      const theme = createTheme({ color: true, ascii: false });
      const terminal = makeFakeTerminal();
      const tui = new ModalScreen(terminal);
      const nav = new Navigator(tui, terminal, theme);
      let openedProj: string | null = null;
      let switchedProj: string | null = null;

      const screen = new ProjectsScreen(client, {
        currentProjectId: pGit.id,
        currentRepoRoot: pGit.rootPath,
        canSwitchCurrentSession: true,
        onOpenProject: (p) => {
          openedProj = p.id;
        },
        onSwitchCurrentSession: (p) => {
          switchedProj = p.id;
        },
      });
      nav.push(screen);
      await new Promise((r) => setTimeout(r, 40));

      for (const w of [60, 80, 120]) {
        const lines = screen.render(w, 22, theme);
        assert.ok(lines.length <= 22);
        const plain = lines.map(stripTerminalSequences).join("\n");
        assert.ok(plain.includes("PROJECT") && plain.includes("PATH"));
        assert.ok(plain.includes("backend"));
        assert.ok(plain.includes("notes"));
        for (const l of lines) assert.ok(visibleWidth(l) <= w, `ProjectsScreen overflowed ${w}`);
      }

      const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };
      screen.handleInput("j", ctx); // select second row ("notes")
      screen.handleInput("s", ctx); // switch current session
      assert.equal(switchedProj, pFolder.id);

      nav.push(screen);
      await new Promise((r) => setTimeout(r, 30));
      screen.handleInput("k", ctx); // move back to first row ("backend")
      screen.handleInput("\r", ctx); // Enter -> open project
      assert.equal(openedProj, pGit.id);

      // 6. Removing a project unregisters it without deleting files on disk
      await client.request("project.remove", { projectId: pFolder.id });
      assert.equal(existsSync(join(folderProjPath, "todo.md")), true);
      const afterRm = await client.request<ProjectSummary[]>("project.list");
      assert.deepEqual(afterRm.map((p) => p.id), [pGit.id]);
    } finally {
      client.close();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
