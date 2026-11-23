import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { DaemonEventFrame, SessionControlPayload, SessionControlState } from "../src/protocol/daemon-rpc.js";
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
});
