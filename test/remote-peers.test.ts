import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import type { RemoteHostStatus } from "../src/daemon/peer.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon, MAX_PEER_MESSAGE_HOPS } from "../src/daemon/server.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("Symmetric PeerLink, Federated Projects/Sessions & Two-Way Messaging", () => {
  it("peers two daemons over one link, federates projects & sessions, delivers two-way auto-wakeups, queues offline both ways, and enforces hop circuit breaker", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-peers-"));
    const laptopState = join(root, "laptop-state");
    const gpuState = join(root, "gpu-state");
    const laptopSock = join(laptopState, "laptop.sock");
    const gpuSock = join(gpuState, "gpu.sock");
    const laptopProjA = join(root, "laptop-proj-a");
    const laptopProjB = join(root, "laptop-proj-b");
    const gpuProj = join(root, "gpu-proj-ml");

    const laptopPrompts: string[] = [];
    const gpuPrompts: string[] = [];

    const laptopRunner: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest) => {
        laptopPrompts.push(req.initialPrompt);
        // When laptop chat-1 receives a user prompt asking to dispatch to gpu-box, use session_send MCP tool
        if (req.initialPrompt.includes("DISPATCH_TO_GPU:")) {
          const target = req.initialPrompt.split("DISPATCH_TO_GPU:")[1]!.trim();
          const res = await req.executeTool("session_send", {
            target,
            message: "please run the gpu eval",
            expect_reply: true,
          });
          return { text: `Dispatched: ${JSON.stringify(res)}`, stopReason: "completed" };
        }
        return { text: `Laptop ack: ${req.initialPrompt.slice(0, 80)}`, stopReason: "completed" };
      },
    });

    const gpuRunner: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest) => {
        gpuPrompts.push(req.initialPrompt);
        // When gpu-box wakes up on a peer message asking for eval, automatically reply BACK over the reverse PeerLink!
        if (req.initialPrompt.includes("please run the gpu eval")) {
          const match = req.initialPrompt.match(/from\s+([^\s)]+)/);
          const replyTarget = match?.[1] ?? "";
          const msgIdMatch = req.initialPrompt.match(/messageId=([^\s|]+)/);
          await req.executeTool("session_send", {
            target: replyTarget,
            message: "gpu eval passed: 142 tok/s",
            expect_reply: false,
            reply_to_id: msgIdMatch?.[1],
          });
          return { text: "Ran GPU eval and replied to laptop", stopReason: "completed" };
        }
        return { text: `GPU ack: ${req.initialPrompt.slice(0, 80)}`, stopReason: "completed" };
      },
    });

    const laptopCfg = withFixtureCatalog({ ...loadConfig(root), codeMode: "off", stateDir: laptopState, socketPath: laptopSock });
    const gpuCfg = withFixtureCatalog({ ...loadConfig(root), codeMode: "off", stateDir: gpuState, socketPath: gpuSock });

    const laptop = new HarnessDaemon(laptopCfg, {
      dbPath: join(laptopState, "db.sqlite"),
      customRunnerFactory: laptopRunner,
      hostName: "laptop",
    });
    const gpu = new HarnessDaemon(gpuCfg, {
      dbPath: join(gpuState, "db.sqlite"),
      customRunnerFactory: gpuRunner,
      hostName: "gpu-box",
    });

    await gpu.start();
    await laptop.start();

    const laptopClient = new DaemonClient(laptopSock);
    const gpuClient = new DaemonClient(gpuSock);
    await laptopClient.connect();
    await gpuClient.connect();

    try {
      // 1. Create projects on both daemons and peer laptop -> gpu-box
      const pA = await laptopClient.request<{ id: string }>("project.create", { path: laptopProjA, name: "web-ui", createDir: true });
      const pB = await laptopClient.request<{ id: string }>("project.create", { path: laptopProjB, name: "shared-sdk", createDir: true });
      await gpuClient.request("project.create", { path: gpuProj, name: "ml-trainer", createDir: true });

      const added = await laptopClient.request<RemoteHostStatus>("remote.add", {
        name: "gpu-box",
        sshTarget: gpuSock,
        autoConnect: true,
      });
      assert.equal(added.name, "gpu-box");
      assert.equal(added.status, "connected");
      assert.equal(added.remoteHostName, "gpu-box");

      // gpu-box automatically sees laptop as an inbound connected peer (zero open ports on laptop!)
      const gpuRemotes = await gpuClient.request<RemoteHostStatus[]>("remote.list");
      assert.equal(gpuRemotes.length, 1);
      assert.equal(gpuRemotes[0]!.name, "laptop");
      assert.equal(gpuRemotes[0]!.direction, "inbound");
      assert.equal(gpuRemotes[0]!.status, "connected");

      // 2. Federated project.list & remote project creation from laptop
      const federatedProjects = await laptopClient.request<Array<{ name: string; host: string }>>("project.list", {
        includeRemotes: true,
      });
      assert.ok(federatedProjects.some((p) => p.name === "web-ui" && p.host === "local"));
      assert.ok(federatedProjects.some((p) => p.name === "ml-trainer" && p.host === "gpu-box"));

      // 3. Create sessions on laptop (two projects) and gpu-box (via remote headless chat.create)
      const lapChatA = await laptopClient.request<{ session: { id: string } }>("chat.open", { projectId: pA.id });
      const lapChatB = await laptopClient.request<{ session: { id: string } }>("chat.create", { projectId: pB.id, headless: true });
      const gpuChat = await gpuClient.request<{ session: { id: string } }>("chat.open", { projectId: "ml-trainer" });

      const fedSessions = await laptopClient.request<Array<{ address: string; host: string; id: string }>>("sessions.list", {
        includeRemotes: true,
      });
      assert.ok(fedSessions.some((s) => s.address === `local:${lapChatA.session.id}`));
      assert.ok(fedSessions.some((s) => s.address === `local:${lapChatB.session.id}`));
      assert.ok(fedSessions.some((s) => s.address === `gpu-box:${gpuChat.session.id}`));

      // 4. Unified local cross-project messaging + auto-wakeup
      const localSend = await laptopClient.request<{ status: string; woke: boolean }>("session.send_message", {
        fromSessionId: lapChatA.session.id,
        target: `local:${lapChatB.session.id}`,
        body: "check shared-sdk types",
      });
      assert.equal(localSend.status, "delivered");
      assert.equal(localSend.woke, true);
      await waitFor(() => laptopPrompts.some((p) => p.includes("check shared-sdk types")));

      // 5. Bidirectional cross-host messaging via Director MCP `session_send` + reverse reply over SAME link
      await laptopClient.request("chat.send", {
        chatSessionId: lapChatA.session.id,
        text: `DISPATCH_TO_GPU: gpu-box:${gpuChat.session.id}`,
      });
      // GPU woke up, saw message from laptop:<chatA>, and sent reverse reply back to laptop:<chatA>
      await waitFor(() => gpuPrompts.some((p) => p.includes("please run the gpu eval")));
      await waitFor(() => laptopPrompts.some((p) => p.includes("gpu eval passed: 142 tok/s")));

      // Verify `session.read` reads remote session turns & message history cleanly
      const readRemote = await laptopClient.request<{
        host: string;
        address: string;
        turns: Array<{ content: string }>;
        messages: Array<{ body: string }>;
      }>("session.read", { target: `gpu-box:${gpuChat.session.id}`, limit: 10 });
      assert.equal(readRemote.host, "gpu-box");
      assert.equal(readRemote.address, `gpu-box:${gpuChat.session.id}`);
      assert.ok(readRemote.messages.some((m) => m.body.includes("please run the gpu eval")));

      // 6. Offline store-and-forward in BOTH directions + reconnect auto-flush + idempotent dedup
      await laptopClient.request("remote.disconnect", { name: "gpu-box" });
      await waitFor(async () => (await gpuClient.request<RemoteHostStatus[]>("remote.list")).length === 0);

      const queuedOut = await laptopClient.request<{ messageId: string; status: string }>("session.send_message", {
        fromSessionId: lapChatA.session.id,
        target: `gpu-box:${gpuChat.session.id}`,
        body: "offline-outbound-while-asleep",
      });
      assert.equal(queuedOut.status, "queued");

      const queuedRev = await gpuClient.request<{ messageId: string; status: string }>("session.send_message", {
        fromSessionId: gpuChat.session.id,
        target: `laptop:${lapChatA.session.id}`,
        body: "offline-reverse-reply-while-asleep",
      });
      assert.equal(queuedRev.status, "queued");

      // Reconnect laptop -> gpu-box: BOTH outboxes flush automatically!
      await laptopClient.request("remote.connect", { name: "gpu-box" });
      await waitFor(() => gpuPrompts.some((p) => p.includes("offline-outbound-while-asleep")));
      await waitFor(() => laptopPrompts.some((p) => p.includes("offline-reverse-reply-while-asleep")));

      // Duplicate redelivery of same messageId is idempotent and does NOT wake again
      const dup = await gpuClient.request<{ duplicate: boolean; woke: boolean }>("session.deliver_message", {
        id: queuedOut.messageId,
        fromNode: laptop.nodeId,
        fromHost: "laptop",
        fromSessionId: lapChatA.session.id,
        toSessionId: gpuChat.session.id,
        body: "offline-outbound-while-asleep",
      });
      assert.equal(dup.duplicate, true);
      assert.equal(dup.woke, false);

      // 7. Anti-loop circuit breaker after MAX_PEER_MESSAGE_HOPS consecutive peer messages without user turn
      const loopChat = await laptopClient.request<{ session: { id: string } }>("chat.create", {
        projectId: pB.id,
        headless: true,
      });
      for (let i = 1; i <= MAX_PEER_MESSAGE_HOPS; i++) {
        const r = await laptopClient.request<{ woke: boolean; circuitBreakerTripped: boolean }>("session.send_message", {
          fromSessionId: lapChatA.session.id,
          target: `local:${loopChat.session.id}`,
          body: `hop-${i}`,
        });
        assert.equal(r.woke, true);
        assert.equal(r.circuitBreakerTripped, false);
      }
      const tripped = await laptopClient.request<{ woke: boolean; circuitBreakerTripped: boolean }>("session.send_message", {
        fromSessionId: lapChatA.session.id,
        target: `local:${loopChat.session.id}`,
        body: "hop-11-should-trip",
      });
      assert.equal(tripped.woke, false);
      assert.equal(tripped.circuitBreakerTripped, true);
    } finally {
      laptopClient.close();
      gpuClient.close();
      await laptop.stop();
      await gpu.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
