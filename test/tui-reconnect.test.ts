import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { DAEMON_PROTOCOL_REV, type DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { attachDaemonReader, writeDaemonMessage } from "../src/protocol/frames.js";
import { runDirectorChatTui, runNativeScrollbackTui } from "../src/tui/app.js";
import { stripTerminalSequences } from "../src/tui/core/index.js";
import { installAutoReconnect, type ReconnectStatus } from "../src/tui/reconnect.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

function makeFakeTerminal(cols = 100, rows = 30) {
  let onDataCb: ((data: string) => void) | null = null;
  const writes: string[] = [];
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
    write(data) {
      writes.push(data);
    },
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
    writes,
    text: () => stripTerminalSequences(writes.join("")),
    sendInput: (data: string) => onDataCb?.(data),
    typeText: (str: string) => {
      for (const ch of str) onDataCb?.(ch);
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) return count;
    count += 1;
    idx = found + needle.length;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("TUI auto-reconnect after daemon restart", () => {
  it("chat TUI survives a daemon restart", async () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-tui-reconn-chat-")));
    const sockPath = join(stateDir, "d.sock");
    const dbPath = join(stateDir, "db.sqlite");
    const config = withFixtureCatalog({ ...loadConfig(stateDir), stateDir, socketPath: sockPath });

    const daemonA = new HarnessDaemon(config, {
      dbPath,
      customRunnerFactory: () => ({
        run: async () => ({ text: "A1-MARKER", stopReason: "completed" }),
      }),
    });

    const receivedInB: string[] = [];
    let daemonB: HarnessDaemon | null = null;
    const viewerClient = new DaemonClient(sockPath);
    const controllerClient = new DaemonClient(sockPath);

    await daemonA.start();
    try {
      await viewerClient.connect();
      await controllerClient.connect();

      const viewerTerm = makeFakeTerminal(120, 30);
      const controllerTerm = makeFakeTerminal(120, 30);

      let viewerResolved = false;
      let controllerResolved = false;

      // Open the viewer first so it creates the chat session.
      const viewerPromise = runDirectorChatTui({
        client: viewerClient,
        repoRoot: stateDir,
        terminal: viewerTerm.terminal,
      }).finally(() => {
        viewerResolved = true;
      });

      await waitFor(() => daemonA.director.chats.listSessions().length > 0, 4000, "chat session creation");
      const chatSessionId = daemonA.director.chats.listSessions()[0]!.id;
      await waitFor(() => viewerTerm.text().includes(chatSessionId), 4000, "viewer initial render");

      // Open the controller second on the same chat; the first terminal becomes read-only.
      const controllerPromise = runDirectorChatTui({
        client: controllerClient,
        repoRoot: stateDir,
        chatSessionId,
        terminal: controllerTerm.terminal,
      }).finally(() => {
        controllerResolved = true;
      });

      await waitFor(() => viewerTerm.text().includes("READ-ONLY"), 4000, "viewer demoted to read-only");
      await waitFor(() => controllerTerm.text().includes(chatSessionId), 4000, "controller initial render");

      // Send m1 and wait for A1-MARKER to settle on both terminals.
      controllerTerm.typeText("m1");
      controllerTerm.sendInput("\r");
      await waitFor(
        () => viewerTerm.text().includes("A1-MARKER") && controllerTerm.text().includes("A1-MARKER"),
        5000,
        "A1-MARKER rendered on both TUIs",
      );
      await waitFor(() => daemonA.director.activeChatCount() === 0, 4000, "daemon A turn settled");

      // Stop daemon A while idle.
      await daemonA.stop();
      const showsOffline = (text: string) =>
        text.includes("RECONNECTING") || text.includes("Waiting for it to start");
      await waitFor(
        () => showsOffline(viewerTerm.text()) && showsOffline(controllerTerm.text()),
        4000,
        "both TUIs enter offline reconnect state",
      );

      // While offline, submit q1 in the controller and type draft "dr" without submitting.
      controllerTerm.typeText("q1");
      controllerTerm.sendInput("\r");
      await waitFor(
        () => controllerTerm.text().includes("Queued until harnessd reconnects"),
        4000,
        "q1 queued while offline",
      );
      controllerTerm.typeText("dr");
      await waitFor(() => controllerTerm.text().includes("dr"), 4000, "draft typed while offline");

      // Start daemon B on the same socket and DB.
      daemonB = new HarnessDaemon(config, {
        dbPath,
        customRunnerFactory: () => ({
          run: async (req) => {
            const promptText = req.initialPrompt;
            receivedInB.push(promptText);
            if (promptText.includes("dr")) {
              return { text: "B2-DR-DONE", stopReason: "completed" };
            }
            if (promptText.includes("q1")) {
              return { text: "B1-Q1-DONE", stopReason: "completed" };
            }
            return { text: "B-OTHER", stopReason: "completed" };
          },
        }),
      });
      await daemonB.start();

      // Wait for both TUIs to reconnect and for queued q1 to be delivered and answered.
      await waitFor(
        () =>
          viewerTerm.text().includes("Reconnected to harnessd") &&
          controllerTerm.text().includes("Reconnected to harnessd") &&
          controllerTerm.text().includes("B1-Q1-DONE") &&
          viewerTerm.text().includes("B1-Q1-DONE"),
        8000,
        "both TUIs reconnected and q1 answered",
      );
      await waitFor(() => daemonB!.director.activeChatCount() === 0, 4000, "daemon B q1 turn settled");

      // Assert neither TUI exited, A1-MARKER was not duplicated, and q1 ran exactly once.
      assert.equal(viewerResolved, false, "viewer TUI must stay alive across restart");
      assert.equal(controllerResolved, false, "controller TUI must stay alive across restart");
      assert.equal(countOccurrences(viewerTerm.text(), "A1-MARKER"), 1, "A1-MARKER must appear once in viewer");
      assert.equal(countOccurrences(controllerTerm.text(), "A1-MARKER"), 1, "A1-MARKER must appear once in controller");
      assert.equal(receivedInB.length, 1, "runner in daemon B must receive q1 exactly once");
      assert.ok(receivedInB[0]!.includes("q1"), "runner in daemon B must have received q1");

      // Viewer must still be read-only after reconnect.
      const viewerWritesBefore = viewerTerm.writes.length;
      viewerTerm.typeText("viewer-blocked");
      viewerTerm.sendInput("\r");
      await waitFor(
        () => stripTerminalSequences(viewerTerm.writes.slice(viewerWritesBefore).join("")).includes("Read-only"),
        4000,
        "viewer remains read-only",
      );
      assert.equal(receivedInB.length, 1, "viewer submit must not reach daemon B");

      // Submitting Enter alone on controller sends the preserved draft "dr", proving both draft retention and controller ownership.
      controllerTerm.sendInput("\r");
      await waitFor(() => controllerTerm.text().includes("B2-DR-DONE"), 5000, "preserved draft dr sent by controller");
      assert.equal(receivedInB.length, 2, "preserved draft dr must trigger one additional turn on Enter");
      assert.ok(receivedInB[1]!.includes("dr"), "second turn in daemon B must contain preserved draft dr");

      // Clean user exit via Ctrl+].
      viewerTerm.sendInput("\x1d");
      controllerTerm.sendInput("\x1d");
      const [vAction, cAction] = await Promise.all([viewerPromise, controllerPromise]);
      assert.equal(vAction.kind, "exit");
      assert.equal(cAction.kind, "exit");
    } finally {
      viewerClient.close();
      controllerClient.close();
      await daemonA.stop().catch(() => {});
      await daemonB?.stop().catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("run TUI resumes from the last event", async () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-tui-reconn-run-")));
    const sockPath = join(stateDir, "d.sock");
    const dbPath = join(stateDir, "db.sqlite");
    const config = withFixtureCatalog({ ...loadConfig(stateDir), stateDir, socketPath: sockPath });

    const daemonA = new HarnessDaemon(config, { dbPath });
    let daemonB: HarnessDaemon | null = null;
    const client = new DaemonClient(sockPath);

    await daemonA.start();
    try {
      const run = daemonA.db.createRun({
        goal: "Run reconnect test",
        repoRoot: stateDir,
        baseBranch: "main",
        baseSha: "abc123",
      });

      await client.connect();
      const term = makeFakeTerminal(120, 30);
      let resolved = false;
      const tuiPromise = runNativeScrollbackTui({
        client,
        runId: run.id,
        terminal: term.terminal,
      }).finally(() => {
        resolved = true;
      });

      await waitFor(() => term.text().includes(run.id), 4000, "run TUI attached");

      // Emit three marked events before restart.
      daemonA.db.emitEvent(run.id, null, "run.status", { status: "active", summary: "RUN-MARK-1" });
      daemonA.db.emitEvent(run.id, null, "run.status", { status: "active", summary: "RUN-MARK-2" });
      daemonA.db.emitEvent(run.id, null, "run.status", { status: "active", summary: "RUN-MARK-3" });
      await waitFor(
        () =>
          term.text().includes("RUN-MARK-1") &&
          term.text().includes("RUN-MARK-2") &&
          term.text().includes("RUN-MARK-3"),
        4000,
        "first three run markers rendered",
      );

      // Restart daemon on the same socket and DB.
      await daemonA.stop();
      await waitFor(
        () => term.text().includes("RECONNECTING") || term.text().includes("Waiting for it to start"),
        4000,
        "run TUI offline reconnect state",
      );

      daemonB = new HarnessDaemon(config, { dbPath });
      await daemonB.start();
      await waitFor(() => term.text().includes("Reconnected to harnessd"), 8000, "run TUI reconnected");

      // Emit a fourth marked event in daemon B.
      daemonB.db.emitEvent(run.id, null, "run.status", { status: "active", summary: "RUN-MARK-4" });
      await waitFor(() => term.text().includes("RUN-MARK-4"), 4000, "fourth run marker rendered");

      assert.equal(resolved, false, "run TUI must stay alive across restart");
      const fullText = term.text();
      assert.equal(countOccurrences(fullText, "RUN-MARK-1"), 1, "RUN-MARK-1 must appear once");
      assert.equal(countOccurrences(fullText, "RUN-MARK-2"), 1, "RUN-MARK-2 must appear once");
      assert.equal(countOccurrences(fullText, "RUN-MARK-3"), 1, "RUN-MARK-3 must appear once");
      assert.equal(countOccurrences(fullText, "RUN-MARK-4"), 1, "RUN-MARK-4 must appear once");

      term.sendInput("\x1d");
      const action = await tuiPromise;
      assert.equal(action.kind, "exit");
    } finally {
      client.close();
      await daemonA.stop().catch(() => {});
      await daemonB?.stop().catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("incompatible protocol exits with a message", async () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-tui-reconn-incompat-")));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(stateDir), stateDir, socketPath: sockPath });

    const daemonA = new HarnessDaemon(config, { dbPath: ":memory:" });
    const client = new DaemonClient(sockPath);
    let fakeServer: ReturnType<typeof createServer> | null = null;

    const origConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((a) => String(a)).join(" "));
    };

    await daemonA.start();
    try {
      await client.connect();
      const term = makeFakeTerminal(100, 30);
      const tuiPromise = runDirectorChatTui({
        client,
        repoRoot: stateDir,
        terminal: term.terminal,
      });

      await waitFor(() => term.text().includes("pi-harness"), 4000, "chat TUI initial render");
      term.typeText("unsent-draft");
      await waitFor(() => term.text().includes("unsent-draft"), 4000, "draft entered");

      await daemonA.stop();

      // Fake daemon answering ping with an incompatible protocolRev.
      fakeServer = createServer((socket) => {
        attachDaemonReader(socket, {
          onMessage: (raw) => {
            const req = raw as { kind?: string; id?: string; op?: string };
            if (req?.kind !== "req" || !req.id) return;
            if (req.op === "ping") {
              writeDaemonMessage(socket, {
                kind: "res",
                id: req.id,
                ok: true,
                result: { pong: true, pid: 99999, protocolRev: DAEMON_PROTOCOL_REV + 1, releaseId: "rel-future" },
              });
            }
          },
          onError: () => {},
          onEnd: () => {},
        });
      });
      await new Promise<void>((resolve) => fakeServer!.listen(sockPath, resolve));

      const action = await tuiPromise;
      assert.equal(action.kind, "exit");
      const stderrText = errorLines.join("\n");
      assert.ok(stderrText.includes("incompatible version"), `expected incompatible version message, got: ${stderrText}`);
      assert.ok(stderrText.includes("unsent-draft"), `expected unsent draft to be printed, got: ${stderrText}`);
    } finally {
      console.error = origConsoleError;
      client.close();
      await daemonA.stop().catch(() => {});
      if (fakeServer) {
        await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("explicit stop does not respawn the daemon, a crash does", async () => {
    function makeFakeClient() {
      const closeListeners = new Set<() => void>();
      const client = {
        isRemote: false,
        localSocketPath: "/tmp/fake-harnessd.sock",
        connected: false,
        closedByUser: false,
        onClose(fn: () => void) {
          closeListeners.add(fn);
          return () => closeListeners.delete(fn);
        },
        async connect() {
          throw new Error("ENOENT");
        },
        async request() {
          throw new Error("not connected");
        },
      };
      return {
        client: client as unknown as DaemonClient,
        emitClose: () => {
          for (const fn of closeListeners) fn();
        },
      };
    }

    // 1. Explicit stop (`daemon.stopping { restart: false }`) never spawns in 120 simulated seconds.
    {
      const fake = makeFakeClient();
      let simNow = 0;
      let stopped = false;
      const spawnTimes: number[] = [];
      const statuses: ReconnectStatus[] = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      const handle = installAutoReconnect({
        client: fake.client,
        isStopped: () => stopped,
        resync: async () => {},
        onStatus: (s) => statuses.push(s),
        spawnDaemon: () => spawnTimes.push(simNow),
        now: () => simNow,
        random: () => 0.5,
        sleep: async (ms) => {
          simNow += ms;
          if (simNow >= 120_000) {
            stopped = true;
            resolveDone();
          }
          await Promise.resolve();
        },
      });

      const stoppingEvent: DaemonEventFrame = {
        kind: "event",
        seq: 0,
        runId: "",
        taskId: null,
        type: "daemon.stopping",
        payload: { restart: false },
        createdAt: simNow,
      };
      handle.noteDaemonEvent(stoppingEvent);
      assert.equal(handle.expectingRestart, true);

      fake.emitClose();
      assert.equal(handle.offline, true);
      await done;
      handle.dispose();

      assert.ok(simNow >= 120_000, `expected >= 120s simulated, got ${simNow}`);
      assert.equal(spawnTimes.length, 0, "explicit stop must never respawn the daemon");
      assert.ok(statuses.some((s) => s.phase === "waiting_stopped"), "dock must show waiting_stopped phase");
    }

    // 2. Crash (close with no prior event) spawns once between 20 and 30 simulated seconds.
    {
      const fake = makeFakeClient();
      let simNow = 0;
      let stopped = false;
      const spawnTimes: number[] = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      const handle = installAutoReconnect({
        client: fake.client,
        isStopped: () => stopped,
        resync: async () => {},
        onStatus: () => {},
        spawnDaemon: () => spawnTimes.push(simNow),
        now: () => simNow,
        random: () => 0.5,
        sleep: async (ms) => {
          simNow += ms;
          if (simNow >= 30_000) {
            stopped = true;
            resolveDone();
          }
          await Promise.resolve();
        },
      });

      fake.emitClose();
      await done;
      handle.dispose();

      assert.equal(spawnTimes.length, 1, `expected exactly one spawn between 20s and 30s, got ${JSON.stringify(spawnTimes)}`);
      assert.ok(
        spawnTimes[0]! >= 20_000 && spawnTimes[0]! <= 30_000,
        `expected spawn between 20000ms and 30000ms, got ${spawnTimes[0]}`,
      );
    }
  });

  it("run TUI preserves FIFO order across DAEMON_RELOADING rejection for three queued messages", async () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-tui-reconn-fifo-")));
    const sockPath = join(stateDir, "d.sock");
    const sockets = new Set<import("node:net").Socket>();
    const rejected: string[] = [];
    const received: string[] = [];
    let rejectFirstResume = true;
    let clientIdSeq = 0;

    const fakeServer = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const cid = `client-${++clientIdSeq}`;
      attachDaemonReader(socket, {
        onMessage: (raw) => {
          const req = raw as { kind?: string; id?: string; op?: string; params?: Record<string, unknown> };
          if (req?.kind !== "req" || !req.id) return;
          const ok = (result: unknown) => writeDaemonMessage(socket, { kind: "res", id: req.id!, ok: true, result });
          const fail = (error: string) => writeDaemonMessage(socket, { kind: "res", id: req.id!, ok: false, error });

          if (req.op === "ping") {
            ok({ pong: true, pid: process.pid, protocolRev: DAEMON_PROTOCOL_REV, releaseId: "rel-test" });
            return;
          }
          if (req.op === "attach") {
            ok({
              attachmentId: `att-${cid}`,
              run: { id: "run-1", goal: "FIFO test", repoRoot: stateDir, baseBranch: "main", baseSha: "abc", status: "active" },
              tasks: [],
              replay: [],
              throughSeq: 0,
              control: { sessionId: "run-1", clientId: cid, controllerClientId: cid, hasControl: true, controlSeq: 1 },
            });
            return;
          }
          if (req.op === "run.resume") {
            const msg = String(req.params?.message ?? "");
            if (rejectFirstResume) {
              rejectFirstResume = false;
              rejected.push(msg);
              fail("DAEMON_RELOADING: harnessd is restarting for an update. Your request was not started. It is safe to retry after reconnect.");
              // Simulate the daemon closing right after rejecting with DAEMON_RELOADING so the TUI reconnects and drains.
              socket.end();
              return;
            }
            received.push(msg);
            ok({ resumed: true, outcome: "resumed", noteDelivered: true });
            return;
          }
          if (req.op === "session.leave") {
            ok({ ok: true });
            return;
          }
          if (req.op === "work.snapshot") {
            ok(null);
            return;
          }
          ok([]);
        },
        onError: () => {},
        onEnd: () => {},
      });
    });

    await new Promise<void>((resolve) => fakeServer.listen(sockPath, resolve));
    const client = new DaemonClient(sockPath);
    const term = makeFakeTerminal(120, 30);
    let tuiPromise: Promise<{ kind: string }> | null = null;
    try {
      await client.connect();
      tuiPromise = runNativeScrollbackTui({
        client,
        runId: "run-1",
        terminal: term.terminal,
      });

      await waitFor(() => term.text().includes("run-1"), 4000, "run TUI attached");

      // Drop the initial connection so the TUI goes offline and queues A, B, C.
      for (const s of [...sockets]) s.destroy();
      await waitFor(() => term.text().includes("RECONNECTING"), 4000, "run TUI entered reconnecting state");

      for (const msg of ["MSG-A", "MSG-B", "MSG-C"]) {
        term.typeText(msg);
        term.sendInput("\r");
      }

      // Wait until the first send was rejected once and all three messages were subsequently delivered in order.
      await waitFor(() => received.length === 3, 8000, "all three queued messages delivered");
      assert.deepEqual(rejected, ["MSG-A"], "first queued message should be rejected once with DAEMON_RELOADING");
      assert.deepEqual(received, ["MSG-A", "MSG-B", "MSG-C"], "daemon must receive A, B, C exactly once each in order");

      term.sendInput("\x1d");
      const action = await tuiPromise;
      tuiPromise = null;
      assert.equal(action.kind, "exit");
    } finally {
      if (tuiPromise) {
        term.sendInput("\x1d");
        await tuiPromise.catch(() => {});
      }
      client.close();
      for (const s of [...sockets]) s.destroy();
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("chat.steer whose reply is lost in a disconnect is not sent again after reconnect", async () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-tui-reconn-steer-")));
    const sockPath = join(stateDir, "d.sock");
    const sockets = new Set<import("node:net").Socket>();
    const receivedSends: string[] = [];
    const receivedSteers: string[] = [];
    const history: Array<{ seq: number; role: string; content: string; createdAt: number }> = [];
    let clientIdSeq = 0;

    const fakeServer = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const cid = `client-${++clientIdSeq}`;
      attachDaemonReader(socket, {
        onMessage: (raw) => {
          const req = raw as { kind?: string; id?: string; op?: string; params?: Record<string, unknown> };
          if (req?.kind !== "req" || !req.id) return;
          const ok = (result: unknown) => writeDaemonMessage(socket, { kind: "res", id: req.id!, ok: true, result });

          if (req.op === "ping") {
            ok({ pong: true, pid: process.pid, protocolRev: DAEMON_PROTOCOL_REV, releaseId: "rel-test" });
            return;
          }
          if (req.op === "chat.open") {
            const through = history.length > 0 ? history[history.length - 1]!.seq : 0;
            ok({
              session: { id: "chat-1", title: "Steer test", repoRoot: stateDir, projectId: null, profileId: "director", model: "fixture", effort: null },
              project: null,
              history: [],
              historyNext: null,
              historyThrough: through,
              busy: false,
              activeTurnId: null,
              activeText: "",
              activePartial: "",
              control: { sessionId: "chat-1", clientId: cid, controllerClientId: cid, hasControl: true, controlSeq: 1 },
            });
            return;
          }
          if (req.op === "chat.history") {
            const afterSeq = Number(req.params?.afterSeq ?? 0);
            const throughSeq = Number(req.params?.throughSeq ?? Number.MAX_SAFE_INTEGER);
            const rows = history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq);
            ok({ history: rows, historyNext: null });
            return;
          }
          if (req.op === "chat.send") {
            const text = String(req.params?.text ?? "");
            receivedSends.push(text);
            history.push({ seq: history.length + 1, role: "user", content: text, createdAt: Date.now() });
            // Leave the first turn open (no chat.turn.end) so the next submit invokes chat.steer.
            ok({ started: true });
            return;
          }
          if (req.op === "chat.steer") {
            const message = String(req.params?.message ?? "");
            receivedSteers.push(message);
            // Simulate Director accepting & persisting the steer, then disconnecting before the reply reaches the TUI.
            history.push({ seq: history.length + 1, role: "user", content: message, createdAt: Date.now() });
            socket.destroy();
            return;
          }
          if (req.op === "session.leave") {
            ok({ ok: true });
            return;
          }
          if (req.op === "work.snapshot") {
            ok(null);
            return;
          }
          ok([]);
        },
        onError: () => {},
        onEnd: () => {},
      });
    });

    await new Promise<void>((resolve) => fakeServer.listen(sockPath, resolve));
    const client = new DaemonClient(sockPath);
    const term = makeFakeTerminal(120, 30);
    let tuiPromise: Promise<{ kind: string }> | null = null;
    try {
      await client.connect();
      tuiPromise = runDirectorChatTui({
        client,
        repoRoot: stateDir,
        terminal: term.terminal,
      });

      await waitFor(() => term.text().includes("chat-1"), 4000, "chat TUI initial render");

      // Start a live turn.
      term.typeText("first-turn");
      term.sendInput("\r");
      await waitFor(() => receivedSends.includes("first-turn"), 4000, "first-turn sent");

      // Submit a live steer while busy; server stores it and drops the socket before replying.
      term.typeText("STEER-LOST-REPLY");
      term.sendInput("\r");

      await waitFor(
        () => term.text().includes("may not have been delivered") && term.text().includes("Reconnected to harnessd"),
        8000,
        "steer transport loss noticed and TUI reconnected",
      );

      // Send a fresh follow-up message after reconnect; any mistakenly queued steer would have drained first.
      term.typeText("after-reconnect");
      term.sendInput("\r");
      await waitFor(() => receivedSends.includes("after-reconnect"), 4000, "after-reconnect sent");

      assert.deepEqual(receivedSteers, ["STEER-LOST-REPLY"], "steer must have been attempted once");
      assert.deepEqual(
        receivedSends,
        ["first-turn", "after-reconnect"],
        "lost-reply chat.steer must never be resent automatically as a new prompt",
      );

      term.sendInput("\x1d");
      const action = await tuiPromise;
      tuiPromise = null;
      assert.equal(action.kind, "exit");
    } finally {
      if (tuiPromise) {
        term.sendInput("\x1d");
        await tuiPromise.catch(() => {});
      }
      client.close();
      for (const s of [...sockets]) s.destroy();
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("remote client after explicit daemon stop exits without calling connect()", async () => {
    const closeListeners = new Set<() => void>();
    let connectCalls = 0;
    let sleepCalls = 0;
    const fakeRemoteClient = {
      isRemote: true,
      remoteHost: "buildbox",
      localSocketPath: null,
      connected: false,
      closedByUser: false,
      connectionEpoch: 1,
      onClose(fn: () => void) {
        closeListeners.add(fn);
        return () => closeListeners.delete(fn);
      },
      async connect() {
        connectCalls += 1;
        throw new Error("connect() must not be called for stopped remote daemon");
      },
      async request() {
        throw new Error("not connected");
      },
      disconnect() {},
    };

    const statuses: ReconnectStatus[] = [];
    const handle = installAutoReconnect({
      client: fakeRemoteClient as unknown as DaemonClient,
      isStopped: () => false,
      resync: async () => {},
      onStatus: (s) => statuses.push(s),
      sleep: async () => {
        sleepCalls += 1;
      },
    });

    handle.noteDaemonEvent({
      kind: "event",
      seq: 0,
      runId: "",
      taskId: null,
      type: "daemon.stopping",
      payload: { restart: false },
      createdAt: Date.now(),
    });
    for (const fn of [...closeListeners]) fn();
    await Promise.resolve();
    handle.dispose();

    assert.equal(connectCalls, 0, "connect() must never be called after remote explicit stop");
    assert.equal(sleepCalls, 0, "sleep() must not run after remote explicit stop");
    assert.equal(statuses.length, 1, "expected one final terminal status");
    assert.equal(statuses[0]!.phase, "incompatible");
    assert.equal(
      statuses[0]!.message,
      "harnessd on buildbox was stopped. Start pi-harness again to reconnect.",
    );
  }, 5_000);
});
