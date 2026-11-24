import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { DaemonEventFrame, SessionControlPayload, SessionControlState } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui, runNativeScrollbackTui } from "../src/tui/app.js";
import { stripTerminalSequences } from "../src/tui/core/index.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function connect(sockPath: string): Promise<{ client: DaemonClient; frames: DaemonEventFrame[] }> {
  const client = new DaemonClient(sockPath);
  await client.connect();
  const frames: DaemonEventFrame[] = [];
  client.onEvent((f) => frames.push(f));
  return { client, frames };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val !== undefined) return val;
    await tick(15);
  }
  throw new Error("Timed out waiting for condition");
}

function controlEvents(frames: DaemonEventFrame[]): SessionControlPayload[] {
  return frames
    .filter((f) => f.type === "session.control_changed")
    .map((f) => f.payload as SessionControlPayload);
}

describe("Non-destructive session takeover and control reclaim", () => {
  it("keeps prior chat client open as viewer, gates input, streams output, reclaims, and leaves uncontrolled on disconnect", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ctrl-chat-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          req.callbacks.onTextDelta?.("hello back");
          return { text: "hello back", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const c1 = await connect(sockPath);
      const c2 = await connect(sockPath);
      const c3 = await connect(sockPath);
      try {
        // 1. Non-destructive takeover
        const o1 = (await c1.client.request("chat.open", { repoRoot: stateDir })) as {
          session: { id: string };
          tookOver: boolean;
          control: SessionControlState;
        };
        assert.equal(o1.tookOver, false);
        assert.equal(o1.control.hasControl, true);
        assert.equal(o1.control.controllerClientId, o1.control.clientId);

        const chatSessionId = o1.session.id;
        const o2 = (await c2.client.request("chat.open", { chatSessionId })) as {
          tookOver: boolean;
          control: SessionControlState;
        };
        assert.equal(o2.tookOver, true);
        assert.equal(o2.control.hasControl, true);
        assert.equal(o2.control.controllerClientId, o2.control.clientId);

        const ev1 = await waitFor(() => controlEvents(c1.frames)[0]);
        assert.equal(ev1.sessionId, chatSessionId);
        assert.equal(ev1.kind, "chat");
        assert.equal(ev1.controllerClientId, o2.control.clientId);
        assert.equal(ev1.reason, "attached");
        assert.equal(controlEvents(c2.frames).length, 0);
        assert.ok(!c1.frames.some((f) => f.type === "session.taken_over"));

        // Past the old 200ms eviction destroy timer, c1 stays alive.
        await tick(300);
        const pong = (await c1.client.request("ping")) as { pong: boolean };
        assert.equal(pong.pong, true);

        // 2. Server-side rejection of viewer inputs
        await assert.rejects(() => c1.client.request("chat.send", { chatSessionId, text: "blocked" }), /read-only/i);
        await assert.rejects(
          () => c1.client.request("chat.steer", { chatSessionId, turnId: "t1", message: "blocked" }),
          /read-only/i,
        );
        await assert.rejects(() => c1.client.request("chat.cancel", { chatSessionId, turnId: "t1" }), /read-only/i);
        await assert.rejects(() => c1.client.request("chat.update", { chatSessionId, title: "Nope" }), /read-only/i);

        const historyBefore = (await c1.client.request("chat.history", { chatSessionId })) as Array<{
          role: string;
          content: string;
        }>;
        assert.ok(!historyBefore.some((h) => h.role === "user" && h.content === "blocked"));

        // 3. Observer receives streamed output from controller's turn
        c1.frames.length = 0;
        c2.frames.length = 0;
        await c2.client.request("chat.send", { chatSessionId, text: "hi from c2" });
        const startEv = await waitFor(() => c1.frames.find((f) => f.type === "chat.turn.start"));
        assert.equal((startEv.payload as { reason?: string; text?: string }).reason, "user");
        assert.equal((startEv.payload as { reason?: string; text?: string }).text, "hi from c2");
        await waitFor(() => c1.frames.find((f) => f.type === "chat.delta"));
        await waitFor(() => c1.frames.find((f) => f.type === "chat.turn.end"));
        assert.ok(!c2.frames.some((f) => f.type === "chat.turn.start"));

        // 4. Reclaim via session.take_control (and idempotency)
        c2.frames.length = 0;
        const reclaim1 = (await c1.client.request("session.take_control", { sessionId: chatSessionId })) as SessionControlState & {
          tookOver: boolean;
        };
        assert.equal(reclaim1.hasControl, true);
        assert.equal(reclaim1.tookOver, true);
        assert.equal(reclaim1.controllerClientId, o1.control.clientId);

        const ev2 = await waitFor(() => controlEvents(c2.frames)[0]);
        assert.equal(ev2.controllerClientId, o1.control.clientId);
        assert.equal(ev2.reason, "taken");

        await assert.rejects(() => c2.client.request("chat.send", { chatSessionId, text: "blocked2" }), /read-only/i);
        const steerRes = (await c1.client.request("chat.steer", {
          chatSessionId,
          turnId: "no-turn",
          message: "noop",
        })) as { steered: boolean; cancelled: boolean };
        assert.deepEqual(steerRes, { steered: false, cancelled: false });

        c2.frames.length = 0;
        const reclaimAgain = (await c1.client.request("session.take_control")) as SessionControlState & {
          tookOver: boolean;
        };
        assert.equal(reclaimAgain.tookOver, false);
        await tick(40);
        assert.equal(controlEvents(c2.frames).length, 0);

        // 5. Controller disconnects -> uncontrolled (no auto-promote)
        c2.frames.length = 0;
        c1.client.close();
        const discEv = await waitFor(() => controlEvents(c2.frames)[0]);
        assert.equal(discEv.controllerClientId, null);
        assert.equal(discEv.reason, "disconnected");
        await assert.rejects(() => c2.client.request("chat.send", { chatSessionId, text: "still blocked" }), /read-only/i);

        const listedUncontrolled = (await c2.client.request("sessions.list")) as Array<{ id: string; attached: boolean }>;
        assert.equal(listedUncontrolled.find((s) => s.id === chatSessionId)?.attached, false);

        const reclaimedByC2 = (await c2.client.request("session.take_control")) as SessionControlState & {
          tookOver: boolean;
        };
        assert.equal(reclaimedByC2.hasControl, true);
        const listedControlled = (await c2.client.request("sessions.list")) as Array<{ id: string; attached: boolean }>;
        assert.equal(listedControlled.find((s) => s.id === chatSessionId)?.attached, true);

        // 6. Leaving: observer leave sends nothing; controller leave sends reason "released"
        // Attach c3 as controller, then let c2 (now viewer) leave -> c3 gets no event.
        await c3.client.request("chat.open", { chatSessionId });
        c3.frames.length = 0;
        await c2.client.request("session.leave");
        await tick(40);
        assert.equal(controlEvents(c3.frames).length, 0);

        // Re-attach c2 as controller, then c2 leaves -> c3 (viewer) gets released.
        await c2.client.request("chat.open", { chatSessionId });
        c3.frames.length = 0;
        await c2.client.request("session.leave");
        const relEv = await waitFor(() => controlEvents(c3.frames)[0]);
        assert.equal(relEv.controllerClientId, null);
        assert.equal(relEv.reason, "released");

        // 7. session.take_control when not attached rejects
        await assert.rejects(() => c2.client.request("session.take_control"), /Not attached/);
      } finally {
        c1.client.close();
        c2.client.close();
        c3.client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("handles run attach takeover, shared event fan-out, and read-only gating while allowing unattached CLI calls", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ctrl-run-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });
    const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });

    await daemon.start();
    try {
      const run = daemon.db.createRun({ goal: "Run takeover test", repoRoot: stateDir, baseBranch: "main", baseSha: "abc" });
      const c1 = await connect(sockPath);
      const c2 = await connect(sockPath);
      const c3 = await connect(sockPath);
      try {
        const a1 = (await c1.client.request("attach", { runId: run.id })) as {
          tookOver: boolean;
          control: SessionControlState;
        };
        assert.equal(a1.tookOver, false);
        assert.equal(a1.control.kind, "run");
        assert.equal(a1.control.hasControl, true);

        const a2 = (await c2.client.request("attach", { runId: run.id })) as {
          tookOver: boolean;
          control: SessionControlState;
        };
        assert.equal(a2.tookOver, true);
        assert.equal(a2.control.hasControl, true);

        const ev = await waitFor(() => controlEvents(c1.frames)[0]);
        assert.equal(ev.kind, "run");
        assert.equal(ev.sessionId, run.id);
        assert.equal(ev.controllerClientId, a2.control.clientId);
        assert.equal(ev.reason, "attached");

        // Emitted run event reaches both controller and viewer.
        daemon.db.emitEvent(run.id, null, "agent.text_delta", { text: "shared-output" });
        await waitFor(() => c1.frames.find((f) => f.type === "agent.text_delta"));
        await waitFor(() => c2.frames.find((f) => f.type === "agent.text_delta"));

        // Viewer is rejected by the read-only gate BEFORE delayMs validation; controller and unattached c3 pass the gate.
        await assert.rejects(
          () => c1.client.request("run.schedule_resume", { runId: run.id, delayMs: -1 }),
          /read-only/i,
        );
        await assert.rejects(
          () => c2.client.request("run.schedule_resume", { runId: run.id, delayMs: -1 }),
          /delayMs must be a positive/,
        );
        await assert.rejects(
          () => c3.client.request("run.schedule_resume", { runId: run.id, delayMs: -1 }),
          /delayMs must be a positive/,
        );
      } finally {
        c1.client.close();
        c2.client.close();
        c3.client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes session and run aliases across control binding, checks, events, and gates session.send_message for viewers", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ctrl-alias-"));
    const projB = join(stateDir, "proj-b");
    mkdirSync(projB, { recursive: true });
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });
    const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });

    await daemon.start();
    try {
      const run = daemon.db.createRun({ goal: "Alias test", repoRoot: stateDir, baseBranch: "main", baseSha: "abc" });
      const runAlias = run.id.toUpperCase(); // e.g. RUN-1 -> run-1
      const c1 = await connect(sockPath);
      const c2 = await connect(sockPath);
      const c3 = await connect(sockPath);
      try {
        // Run alias takeover: attaching via alias resolves to canonical run.id and takes over c1
        await c1.client.request("attach", { runId: run.id });
        const a2 = (await c2.client.request("attach", { runId: runAlias })) as {
          tookOver: boolean;
          control: SessionControlState;
        };
        assert.equal(a2.tookOver, true);
        assert.equal(a2.control.sessionId, run.id);
        assert.equal(a2.control.hasControl, true);

        const runEv = await waitFor(() => controlEvents(c1.frames)[0]);
        assert.equal(runEv.sessionId, run.id);
        assert.equal(runEv.controllerClientId, a2.control.clientId);

        // Canonical run event reaches the alias-attached socket too
        daemon.db.emitEvent(run.id, null, "agent.text_delta", { text: "alias-event" });
        await waitFor(() => c1.frames.find((f) => f.type === "agent.text_delta"));
        await waitFor(() => c2.frames.find((f) => f.type === "agent.text_delta"));

        // Viewer cannot bypass run gate via alias
        await assert.rejects(
          () => c1.client.request("run.schedule_resume", { runId: runAlias, delayMs: -1 }),
          /read-only/i,
        );

        // Chat alias: chat.set_project and session.send_message cannot bypass viewer gate via alias
        const p2 = (await c3.client.request("project.create", { path: projB, name: "proj-b", createDir: false })) as { id: string };
        const chat1 = (await c1.client.request("chat.open", { repoRoot: stateDir })) as { session: { id: string; projectId: string | null } };
        const chatAlias = chat1.session.id.toUpperCase();
        await c2.client.request("chat.open", { chatSessionId: chatAlias });

        await assert.rejects(
          () => c1.client.request("chat.set_project", { chatSessionId: chatAlias, projectId: p2.id }),
          /read-only/i,
        );
        assert.notEqual(daemon.director.chats.getSession(chat1.session.id)?.projectId, p2.id);

        // Viewer cannot call session.send_message (bound or aliased), while unattached c3 can
        const otherChat = (await c3.client.request("chat.create", { projectId: p2.id, headless: true })) as { session: { id: string } };
        await assert.rejects(
          () => c1.client.request("session.send_message", { target: otherChat.session.id, body: "blocked-viewer" }),
          /read-only/i,
        );
        await assert.rejects(
          () =>
            c1.client.request("session.send_message", {
              fromSessionId: chatAlias,
              target: otherChat.session.id,
              body: "blocked-alias",
            }),
          /read-only/i,
        );
        const unattachedSend = (await c3.client.request("session.send_message", {
          fromSessionId: "cli",
          target: otherChat.session.id,
          body: "allowed-oneshot",
          expectReply: false,
        })) as { status: string };
        assert.equal(unattachedSend.status, "delivered");
      } finally {
        c1.client.close();
        c2.client.close();
        c3.client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("gates task.resume on run controller so read-only viewers cannot resume tasks or send guidance", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ctrl-task-resume-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });
    const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });

    await daemon.start();
    try {
      const run = daemon.db.createRun({ goal: "Task resume gate", repoRoot: stateDir, baseBranch: "main", baseSha: "abc" });
      const task = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "test",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture",
      });
      daemon.db.updateTask(task.id, { status: "completed", summary: "done" });

      const c1 = await connect(sockPath);
      const c2 = await connect(sockPath);
      const c3 = await connect(sockPath);
      try {
        await c1.client.request("attach", { runId: run.id });
        await c2.client.request("attach", { runId: run.id });

        // Viewer c1 is rejected by the read-only gate
        await assert.rejects(
          () => c1.client.request("task.resume", { taskId: task.id, note: "viewer note" }),
          /read-only/i,
        );

        // Controller c2 and unattached c3 are NOT blocked by the read-only gate
        for (const allowed of [c2.client, c3.client]) {
          try {
            await allowed.request("task.resume", { taskId: task.id });
          } catch (err) {
            assert.doesNotMatch(err instanceof Error ? err.message : String(err), /read-only/i);
          }
        }
      } finally {
        c1.client.close();
        c2.client.close();
        c3.client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores a stale session.take_control reply when a newer session.control_changed event arrives first, and excludes steer origin", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ctrl-seq-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });

    // 1. Real daemon monotonic controlSeq + steer echo exclusion (even when ownership transfers mid-steer)
    let releaseTurn!: () => void;
    const turnBarrier = new Promise<void>((r) => {
      releaseTurn = r;
    });
    let markHandleReady!: () => void;
    const handleReady = new Promise<void>((r) => {
      markHandleReady = r;
    });
    let markSteerEntered!: () => void;
    const steerEntered = new Promise<void>((r) => {
      markSteerEntered = r;
    });
    let releaseSteer!: () => void;
    const steerBarrier = new Promise<void>((r) => {
      releaseSteer = r;
    });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          req.onHandle?.({
            steer: async () => {
              markSteerEntered();
              await steerBarrier;
              return true;
            },
            cancel: async () => {
              releaseSteer();
              releaseTurn();
            },
          });
          markHandleReady();
          await turnBarrier;
          return { text: "done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const c1 = await connect(sockPath);
      const c2 = await connect(sockPath);
      try {
        const o1 = (await c1.client.request("chat.open", { repoRoot: stateDir })) as {
          session: { id: string };
          control: SessionControlState;
        };
        const chatSessionId = o1.session.id;
        const o2 = (await c2.client.request("chat.open", { chatSessionId })) as { control: SessionControlState };
        assert.ok((o2.control.controlSeq ?? 0) > (o1.control.controlSeq ?? 0));

        const ev1 = await waitFor(() => controlEvents(c1.frames)[0]);
        assert.equal(ev1.controlSeq, o2.control.controlSeq);

        const r1 = (await c1.client.request("session.take_control")) as SessionControlState & { tookOver: boolean };
        const r2 = (await c2.client.request("session.take_control")) as SessionControlState & { tookOver: boolean };
        assert.ok((r1.controlSeq ?? 0) > (o2.control.controlSeq ?? 0));
        assert.ok((r2.controlSeq ?? 0) > (r1.controlSeq ?? 0));

        // Mid-steer ownership transfer: c2 steers, c1 takes control while steer awaits; c1 gets chat.steered with originClientId=c2, c2 does not
        c1.frames.length = 0;
        c2.frames.length = 0;
        const sendPromise = c2.client.request("chat.send", { chatSessionId, turnId: "turn-steer", text: "go" });
        await handleReady;
        const steerPromise = c2.client.request("chat.steer", {
          chatSessionId,
          turnId: "turn-steer",
          message: "change course",
        }) as Promise<{ steered: boolean }>;
        await steerEntered;
        await c1.client.request("session.take_control");
        releaseSteer();
        const steerRes = await steerPromise;
        assert.equal(steerRes.steered, true);
        const steerEv = await waitFor(() => c1.frames.find((f) => f.type === "chat.steered"));
        assert.equal((steerEv.payload as { originClientId?: string }).originClientId, o2.control.clientId);
        await tick(40);
        assert.ok(!c2.frames.some((f) => f.type === "chat.steered"), "steer broadcast must exclude originating socket");
        releaseTurn();
        await sendPromise;
      } finally {
        c1.client.close();
        c2.client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }

    // 2. TUI ordering: event granting cli-b (seq 4) arrives before awaited session.take_control reply for cli-a (seq 3) resolves
    let onDataCb: ((data: string) => void) | null = null;
    const sendInput = (data: string) => onDataCb?.(data);
    const writes: string[] = [];
    const terminal: Terminal = {
      columns: 100,
      rows: 30,
      kittyProtocolActive: false,
      start(onData) {
        onDataCb = onData;
      },
      stop() {
        onDataCb = null;
      },
      async drainInput() {},
      write(d) {
        writes.push(d);
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

    const eventListeners = new Set<(ev: DaemonEventFrame) => void>();
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const emit = (ev: DaemonEventFrame) => {
      for (const fn of eventListeners) fn(ev);
    };
    const mockClient = {
      async request<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push({ op, params });
        if (op === "chat.open") {
          return {
            session: {
              id: "chat-99",
              projectId: null,
              repoRoot: "/repo",
              title: "Race Test",
              profileId: "acp:codex",
              model: "openai/gpt-6.2-sol",
              effort: "high",
              acpSessionId: null,
              modelSelectionContext: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            history: [],
            historyNext: null,
            historyThrough: 0,
            activeTurnId: null,
            activeText: "",
            activePartial: "",
            tookOver: false,
            control: { sessionId: "chat-99", kind: "chat", clientId: "cli-a", controllerClientId: "cli-b", hasControl: false, controlSeq: 2 },
            busy: false,
          } as T;
        }
        if (op === "session.take_control") {
          // Simulate single-chunk race: reply for seq 3 resolves, then event for seq 4 runs synchronously before await resumes
          return await new Promise<T>((resolve) => {
            setTimeout(() => {
              resolve({
                sessionId: "chat-99",
                kind: "chat",
                clientId: "cli-a",
                controllerClientId: "cli-a",
                hasControl: true,
                controlSeq: 3,
                tookOver: true,
              } as T);
              emit({
                kind: "event",
                seq: 0,
                runId: "chat-99",
                taskId: "chat-99",
                type: "session.control_changed",
                createdAt: Date.now(),
                payload: {
                  sessionId: "chat-99",
                  kind: "chat",
                  controllerClientId: "cli-b",
                  reason: "taken",
                  controlSeq: 4,
                },
              });
            }, 5);
          });
        }
        if (op === "work.snapshot") {
          return { generatedAt: Date.now(), latestSeq: 0, goals: [], runs: [], escalations: [], timers: [], merges: [], worktrees: [], messages: [], inbox: [] } as T;
        }
        if (op === "session.leave") return { daemonWillQuit: false } as T;
        return {} as T;
      },
      onEvent(fn: (ev: DaemonEventFrame) => void) {
        eventListeners.add(fn);
        return () => eventListeners.delete(fn);
      },
      onClose() {
        return () => {};
      },
      close() {},
    } as unknown as DaemonClient;

    const tuiPromise = runDirectorChatTui({ client: mockClient, repoRoot: "/repo", terminal });
    await tick(40);

    // Trigger Ctrl+Y reclaim; stale seq 3 reply must NOT overwrite newer seq 4 event granting cli-b
    writes.length = 0;
    sendInput("\x19");
    await tick(50);

    // Must still be READ-ONLY: typing + Enter must NOT call chat.send, and another Ctrl+Y must still trigger take_control
    for (const ch of "blocked") sendInput(ch);
    sendInput("\r");
    await tick(30);
    assert.equal(calls.filter((c) => c.op === "chat.send").length, 0, "losing TUI must remain read-only after stale reply");
    assert.ok(writes.map(stripTerminalSequences).join("\n").includes("READ-ONLY"));

    sendInput("\x1d");
    await tuiPromise;
  });

  it("canonicalizes session aliases on local and peer session.list_messages and reports canonical delivery targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-harness-msg-alias-"));
    const localState = join(root, "local");
    const peerState = join(root, "peer");
    const localSock = join(localState, "d.sock");
    const peerSock = join(peerState, "d.sock");
    mkdirSync(localState, { recursive: true });
    mkdirSync(peerState, { recursive: true });

    const localDaemon = new HarnessDaemon(withFixtureCatalog({ ...loadConfig(root), stateDir: localState, socketPath: localSock }), {
      dbPath: join(localState, "db.sqlite"),
      hostName: "local-box",
    });
    const peerDaemon = new HarnessDaemon(withFixtureCatalog({ ...loadConfig(root), stateDir: peerState, socketPath: peerSock }), {
      dbPath: join(peerState, "db.sqlite"),
      hostName: "peer-box",
    });
    await peerDaemon.start();
    await localDaemon.start();
    const localClient = new DaemonClient(localSock);
    const peerClient = new DaemonClient(peerSock);
    await localClient.connect();
    await peerClient.connect();

    try {
      const added = await localClient.request<{ status: string }>("remote.add", {
        name: "peer-box",
        sshTarget: peerSock,
        autoConnect: true,
      });
      assert.equal(added.status, "connected");
      const localTarget = await localClient.request<{ session: { id: string } }>("chat.create", {
        repoRoot: localState,
        headless: true,
      });
      const peerTarget = await peerClient.request<{ session: { id: string } }>("chat.create", {
        repoRoot: peerState,
        headless: true,
      });

      const localAlias = localTarget.session.id.toUpperCase();
      const localSent = await localClient.request<{ status: string; target: string }>("session.send_message", {
        fromSessionId: "cli",
        target: localAlias,
        body: "hello-local-alias",
        expectReply: false,
      });
      assert.equal(localSent.status, "delivered");
      assert.equal(localSent.target, `local:${localTarget.session.id}`);

      const localListed = await localClient.request<Array<{ toSessionId: string; body: string }>>("session.list_messages", {
        sessionId: localAlias,
      });
      assert.equal(localListed.length, 1);
      assert.equal(localListed[0]?.toSessionId, localTarget.session.id);
      assert.equal(localListed[0]?.body, "hello-local-alias");

      const peerAlias = peerTarget.session.id.toUpperCase();
      const peerSent = await localClient.request<{ status: string; target: string }>("session.send_message", {
        fromSessionId: localTarget.session.id,
        target: `peer-box:${peerAlias}`,
        body: "hello-peer-alias",
        expectReply: false,
      });
      assert.equal(peerSent.status, "delivered");
      assert.equal(peerSent.target, `peer-box:${peerTarget.session.id}`);

      const peerListed = await localClient.request<Array<{ toSessionId: string; body: string }>>("session.list_messages", {
        target: `peer-box:${peerAlias}`,
      });
      assert.equal(peerListed.length, 1);
      assert.equal(peerListed[0]?.toSessionId, peerTarget.session.id);
      assert.equal(peerListed[0]?.body, "hello-peer-alias");
    } finally {
      localClient.close();
      peerClient.close();
      await localDaemon.stop();
      await peerDaemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles aliased control.sessionId on mixed-version attach and canonicalized --task aliases in run TUI", async () => {
    let onDataCb: ((data: string) => void) | null = null;
    const sendInput = (data: string) => onDataCb?.(data);
    const writes: string[] = [];
    const terminal: Terminal = {
      columns: 100,
      rows: 30,
      kittyProtocolActive: false,
      start(onData) {
        onDataCb = onData;
      },
      stop() {
        onDataCb = null;
      },
      async drainInput() {},
      write(d) {
        writes.push(d);
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

    const eventListeners = new Set<(ev: DaemonEventFrame) => void>();
    const takeCalls: Array<Record<string, unknown>> = [];
    const emit = (ev: DaemonEventFrame) => {
      for (const fn of eventListeners) fn(ev);
    };
    const mockClient = {
      async request<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
        if (op === "attach") {
          // Simulate a rev-8 daemon where run.id is canonical ("run-1") while control.sessionId keeps alias ("run-01"),
          // and task alias "T-1" normalizes to canonical "t-1".
          return {
            attachmentId: "att-1",
            attached: true,
            tookOver: false,
            control: {
              sessionId: "run-01",
              kind: "run",
              clientId: "cli-a",
              controllerClientId: "cli-a",
              hasControl: true,
              controlSeq: 1,
            },
            run: { id: "run-1", repoRoot: "/repo", status: "active" },
            taskId: "t-1",
            tasks: [{ id: "t-1" }],
            replay: [
              {
                seq: 1,
                runId: "run-1",
                taskId: "t-1",
                type: "agent.text_delta",
                payload: { text: "replayed-task-output" },
                createdAt: Date.now(),
              },
            ],
            throughSeq: 1,
          } as T;
        }
        if (op === "session.take_control") {
          takeCalls.push(params);
          assert.equal(params.sessionId, "run-01");
          return {
            sessionId: "run-01",
            kind: "run",
            clientId: "cli-a",
            controllerClientId: "cli-a",
            hasControl: true,
            controlSeq: 3,
            tookOver: true,
          } as T;
        }
        if (op === "work.snapshot") {
          return { generatedAt: Date.now(), latestSeq: 1, goals: [], runs: [], escalations: [], timers: [], merges: [], worktrees: [], messages: [], inbox: [] } as T;
        }
        if (op === "session.leave") return { daemonWillQuit: false } as T;
        return {} as T;
      },
      onEvent(fn: (ev: DaemonEventFrame) => void) {
        eventListeners.add(fn);
        return () => eventListeners.delete(fn);
      },
      onClose() {
        return () => {};
      },
      close() {},
    } as unknown as DaemonClient;

    const tuiPromise = runNativeScrollbackTui({
      client: mockClient,
      runId: "run-01",
      initialTaskId: "T-1",
      terminal,
    });
    await tick(40);

    // Live task event for canonical t-1 must also render (not be dropped because initialTaskId was T-1)
    emit({
      kind: "event",
      seq: 2,
      runId: "run-1",
      taskId: "t-1",
      type: "agent.text_delta",
      payload: { text: " live-task-output" },
      createdAt: Date.now(),
    });
    await tick(30);
    const renderedEvents = writes.map(stripTerminalSequences).join("\n");
    assert.ok(renderedEvents.includes("replayed-task-output"), "replay event for canonical t-1 should render when attached with T-1");
    assert.ok(renderedEvents.includes("live-task-output"), "live event for canonical t-1 should render when attached with T-1");

    // Ownership loss event keyed by bound alias control.sessionId ("run-01") must transition TUI to READ-ONLY
    writes.length = 0;
    emit({
      kind: "event",
      seq: 0,
      runId: "run-01",
      taskId: null,
      type: "session.control_changed",
      createdAt: Date.now(),
      payload: {
        sessionId: "run-01",
        kind: "run",
        controllerClientId: "cli-b",
        reason: "attached",
        controlSeq: 2,
      },
    });
    await tick(30);
    assert.ok(writes.map(stripTerminalSequences).join("\n").includes("READ-ONLY"));

    // Ctrl+Y reclaim must send the bound control.sessionId ("run-01"), not run.id ("run-1")
    sendInput("\x19");
    await tick(30);
    assert.equal(takeCalls.length, 1);
    assert.equal(takeCalls[0]?.sessionId, "run-01");

    sendInput("\x1d");
    await tuiPromise;
  });

  it("rejected chat.steer leaves the active turn running and completes with cancelled: false (while chat.cancel still cancels)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-steer-no-cancel-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });

    let turnIndex = 0;
    const handleReadyResolvers: Array<() => void> = [];
    const turnBarriers: Array<{ promise: Promise<void>; release: () => void }> = [];
    const makeBarrier = () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      return { promise, release };
    };
    let abortWhileRunningCalls = 0;
    const abortedWhileRunning: boolean[] = [];
    let steerCalls = 0;

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          const idx = turnIndex++;
          const barrier = makeBarrier();
          turnBarriers[idx] = barrier;
          let running = true;
          const onAbort = () => {
            if (running) {
              abortWhileRunningCalls += 1;
              barrier.release();
            }
          };
          req.signal.addEventListener("abort", onAbort, { once: true });
          req.onHandle?.({
            steer: async () => {
              steerCalls += 1;
              return false;
            },
            cancel: async () => {
              barrier.release();
            },
          });
          handleReadyResolvers[idx]?.();
          req.callbacks.onTextDelta?.(`reply-${idx}`);
          await barrier.promise;
          running = false;
          req.signal.removeEventListener("abort", onAbort);
          abortedWhileRunning[idx] = req.signal.aborted;
          return { text: `reply-${idx}`, stopReason: req.signal.aborted ? "cancelled" : "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const c1 = await connect(sockPath);
      try {
        const opened = (await c1.client.request("chat.open", { repoRoot: stateDir })) as {
          session: { id: string };
        };
        const chatSessionId = opened.session.id;

        // 1. Start turn 1 and issue chat.steer rejected by Director -> must NOT cancel the turn
        const ready1 = new Promise<void>((r) => {
          handleReadyResolvers[0] = r;
        });
        const send1 = c1.client.request("chat.send", { chatSessionId, turnId: "turn-reject-steer", text: "hello" });
        await ready1;

        const steerRes = (await c1.client.request("chat.steer", {
          chatSessionId,
          turnId: "turn-reject-steer",
          message: "steer attempt",
        })) as { steered: boolean; cancelled: boolean };

        assert.deepEqual(steerRes, { steered: false, cancelled: false });
        assert.equal(steerCalls, 1);
        assert.equal(abortWhileRunningCalls, 0, "rejected chat.steer must never cancel the active turn");
        await tick(50);
        assert.equal(
          c1.frames.some((f) => f.type === "chat.turn.end"),
          false,
          "active turn must remain running after rejected chat.steer",
        );

        // Let turn 1 finish naturally -> chat.turn.end must report cancelled: false
        turnBarriers[0]!.release();
        await send1;
        const end1 = await waitFor(() => c1.frames.find((f) => f.type === "chat.turn.end"));
        assert.equal((end1.payload as { cancelled?: boolean }).cancelled, false);
        assert.equal(abortedWhileRunning[0], false);
        assert.equal(abortWhileRunningCalls, 0);

        // 2. Explicit chat.cancel keeps its existing cancel behavior
        c1.frames.length = 0;
        const ready2 = new Promise<void>((r) => {
          handleReadyResolvers[1] = r;
        });
        const send2 = c1.client.request("chat.send", { chatSessionId, turnId: "turn-explicit-cancel", text: "second" });
        await ready2;
        const cancelRes = (await c1.client.request("chat.cancel", {
          chatSessionId,
          turnId: "turn-explicit-cancel",
        })) as { steered: boolean; cancelled: boolean };
        assert.deepEqual(cancelRes, { steered: false, cancelled: true });
        assert.equal(abortWhileRunningCalls, 1);
        await send2;
        const end2 = await waitFor(() => c1.frames.find((f) => f.type === "chat.turn.end"));
        assert.equal((end2.payload as { cancelled?: boolean }).cancelled, true);
        assert.equal(abortedWhileRunning[1], true);
      } finally {
        c1.client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
