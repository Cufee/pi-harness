import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { Database } from "bun:sqlite";
import { ensureLocalDaemon, parseArgs } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { SessionMessageStore } from "../src/control-plane/session-messages.js";
import { parseValidatedSshTarget, validatePeerHostName, type RemoteHostStatus } from "../src/daemon/peer.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon, MAX_PEER_MESSAGE_HOPS } from "../src/daemon/server.js";
import { attachDaemonReader, writeDaemonMessage } from "../src/protocol/frames.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { createTheme, FixedDock, ModalScreen, Navigator, stripTerminalSequences, visibleWidth } from "../src/tui/core/index.js";
import { ProjectsScreen } from "../src/tui/projects.js";
import { RemotesScreen } from "../src/tui/remotes.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

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

      // 8. Security: peer.proxy rejects non-allowlisted ops, reverse project.create denied by default (`reverseAccess: "messages"`), unknown host fails fast
      await assert.rejects(
        () => laptopClient.request("peer.proxy", { host: "gpu-box", op: "config.update", params: {} }),
        /cannot be proxied/i,
      );
      await assert.rejects(
        () => gpuClient.request("project.create", { host: "laptop", path: join(root, "evil-clone"), createDir: true }),
        /requires reverseAccess: "full"/i,
      );
      await assert.rejects(
        () => laptopClient.request("session.send_message", { fromSessionId: lapChatA.session.id, target: "nonexistent-host:chat-1", body: "hi" }),
        /Unknown remote host/i,
      );

      // 8b. P1-7: Removing a remote with queued outbound messages marks them failed so daemon isn't pinned busy
      await laptopClient.request("remote.disconnect", { name: "gpu-box" });
      await laptopClient.request("session.send_message", {
        fromSessionId: lapChatA.session.id,
        target: `gpu-box:${gpuChat.session.id}`,
        body: "queued-before-remove",
      });
      const removed = await laptopClient.request<{ removed: string; failedQueued: number }>("remote.remove", { name: "gpu-box" });
      assert.equal(removed.removed, "gpu-box");
      assert.ok(removed.failedQueued >= 1, "remote.remove must fail queued outbound rows for the removed remote");
      // Re-add gpu-box for TUI screen checks below
      await laptopClient.request("remote.add", { name: "gpu-box", sshTarget: gpuSock, autoConnect: true });

      // 9. TUI RemotesScreen, federated ProjectsScreen (HOST column), and FixedDock `[REMOTE: gpu-box]` indicator
      const theme = createTheme();
      const term = makeFakeTerminal();
      const tui = new ModalScreen(term);
      const nav = new Navigator(tui, term, theme);

      const remScreen = new RemotesScreen(laptopClient, { currentHost: "local" });
      nav.push(remScreen);
      await new Promise((r) => setTimeout(r, 80));
      const remLines = remScreen.render(100, 20, theme);
      const remPlain = remLines.map((l) => stripTerminalSequences(l)).join("\n");
      assert.ok(remPlain.includes("local"), "RemotesScreen shows local row");
      assert.ok(remPlain.includes("gpu-box"), "RemotesScreen shows gpu-box row");
      assert.ok(remPlain.includes("ONLINE"), "RemotesScreen shows ONLINE badge");
      for (const l of remLines) assert.ok(visibleWidth(l) <= 100, `RemotesScreen line overflow: ${visibleWidth(l)}`);
      nav.pop();

      const projScreen = new ProjectsScreen(laptopClient, {
        currentHost: "local",
        onOpenProject: () => {},
      });
      nav.push(projScreen);
      await new Promise((r) => setTimeout(r, 80));
      const projLines = projScreen.render(100, 20, theme);
      const projPlain = projLines.map((l) => stripTerminalSequences(l)).join("\n");
      assert.ok(projPlain.includes("HOST"), "ProjectsScreen shows HOST column");
      assert.ok(projPlain.includes("web-ui") && projPlain.includes("ml-trainer"), "ProjectsScreen shows both local and remote projects");
      assert.ok(projPlain.includes("gpu-box"), "ProjectsScreen displays remote host name");
      for (const l of projLines) assert.ok(visibleWidth(l) <= 100, `ProjectsScreen line overflow: ${visibleWidth(l)}`);
      nav.pop();

      const dock = new FixedDock(tui, theme, {
        onSubmit: () => {},
        initialState: {
          idleBanner: "Idle",
          busy: false,
          phaseText: "Ready",
          remoteHost: null,
          rightStatus: "claude-opus-5-5",
          queuedCount: 0,
          hints: [{ key: "Ctrl+P", label: "projects" }],
        },
      });
      const localDockLines = dock.render(100);
      dock.update({ remoteHost: "gpu-box" });
      const remoteDockLines = dock.render(100);
      assert.equal(localDockLines.length, remoteDockLines.length, "Remote badge must preserve constant dock height");
      const remoteDockPlain = remoteDockLines.map((l) => stripTerminalSequences(l)).join("\n");
      assert.ok(remoteDockPlain.includes("[REMOTE: gpu-box]"), "Dock renders prominent [REMOTE: gpu-box] badge");
      for (const l of remoteDockLines) assert.ok(visibleWidth(l) <= 100, `Dock line overflow: ${visibleWidth(l)}`);
    } finally {
      laptopClient.close();
      gpuClient.close();
      await laptop.stop();
      await gpu.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces SSH target validation, repo-config remote isolation, node-pinned outbox, session history isolation, and CLI short flags (-p/-h)", async () => {
    // 1. CLI short flags (-p, -h)
    const parsed1 = parseArgs(["-p", "vanolyze"]);
    assert.deepEqual(parsed1.positional, []);
    assert.equal(parsed1.flags.p, "vanolyze");

    const parsed2 = parseArgs(["-h", "projects"]);
    assert.equal(parsed2.flags.h, true);
    assert.deepEqual(parsed2.positional, ["projects"]);

    const parsed3 = parseArgs(["chat", "send", "gpu-box:chat-4", "run", "eval", "--no-reply"]);
    assert.deepEqual(parsed3.positional, ["chat", "send", "gpu-box:chat-4", "run", "eval"]);
    assert.equal(parsed3.flags["no-reply"], true);

    // 2. SSH option injection rejected
    assert.throws(() => parseValidatedSshTarget("ssh://-oProxyCommand=id@host"), /Invalid SSH/i);
    assert.throws(() => parseValidatedSshTarget("ssh://user@-evilhost"), /Invalid SSH/i);
    assert.deepEqual(parseValidatedSshTarget("ssh://vlad@gpu-box:2222"), {
      host: "vlad@gpu-box",
      port: "2222",
      remoteCmd: "pi-harness bridge",
    });

    // 3. Repo `.pi-harness.json` MUST NOT inject `remotes`
    const repoDir = realpathSync(mkdtempSync("/tmp/pi-repo-sec-"));
    try {
      writeFileSync(
        join(repoDir, ".pi-harness.json"),
        JSON.stringify({ remotes: [{ name: "evil", sshTarget: "ssh://attacker@evil" }] }),
        "utf8",
      );
      const cfg = loadConfig(repoDir);
      assert.ok(!cfg.remotes?.some((r) => r.name === "evil"), "Repo config must never inject remote hosts");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }

    // 4. SessionMessageStore: pinned `toNode` isolation + local/remote same-ID history isolation
    const db = new Database(":memory:");
    const store = new SessionMessageStore(db);
    store.enqueueOutbound({
      fromNode: "node-local",
      fromHost: "laptop",
      fromSessionId: "chat-1",
      toNode: "node-A",
      toHost: "gpu-box",
      toSessionId: "chat-1",
      body: "secret-for-node-A",
    });
    // A different node (node-B) claiming the same hostname "gpu-box" MUST NOT receive rows pinned to node-A!
    const forWrongNode = store.listQueuedOutboundForPeer({ alias: "gpu-box", hostName: "gpu-box", nodeId: "node-B" });
    assert.equal(forWrongNode.length, 0);
    const forRightNode = store.listQueuedOutboundForPeer({ alias: "gpu-box", hostName: "gpu-box", nodeId: "node-A" });
    assert.equal(forRightNode.length, 1);

    // Inbound message from remote `chat-1` addressed to local `chat-2` MUST NOT appear in local `chat-1`'s history!
    store.recordInbound({
      id: "smsg-remote-1",
      fromNode: "node-A",
      fromHost: "gpu-box",
      fromSessionId: "chat-1",
      toNode: "node-local",
      toHost: "laptop",
      toSessionId: "chat-2",
      body: "addressed-to-local-chat-2",
    });
    const localChat1History = store.listForSession("chat-1");
    assert.ok(!localChat1History.some((m) => m.body === "addressed-to-local-chat-2"));
    const localChat2History = store.listForSession("chat-2");
    assert.ok(localChat2History.some((m) => m.body === "addressed-to-local-chat-2"));
    db.close();

    // 5. Boolean long flags do not swallow positional args, hostName validation rejects option strings, and narrow dock prioritizes remote + transient hint
    const parsedBool = parseArgs(["chat", "send", "gpu-box:chat-4", "--no-reply", "hello"]);
    assert.deepEqual(parsedBool.positional, ["chat", "send", "gpu-box:chat-4", "hello"]);
    assert.equal(parsedBool.flags["no-reply"], true);
    assert.throws(() => validatePeerHostName("-oProxyCommand=id"), /Invalid peer hostName/i);
    assert.equal(validatePeerHostName("gpu-box.local"), "gpu-box.local");

    const theme = createTheme();
    const term = makeFakeTerminal();
    const tui = new ModalScreen(term);
    const narrowDock = new FixedDock(tui, theme, {
      onSubmit: () => {},
      initialState: {
        idleBanner: "Idle",
        busy: false,
        phaseText: "Ready",
        remoteHost: "very-long-remote-gpu-cluster-name.internal",
        transientHint: "Press Ctrl+C again to exit",
        rightStatus: "anthropic/claude-opus-5-5 (high)",
        queuedCount: 0,
        hints: [{ key: "Ctrl+P", label: "projects" }],
      },
    });
    const narrowLines = narrowDock.render(60);
    const narrowPlain = narrowLines.map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(narrowPlain.includes("[REMOTE:"), "Narrow 60-col dock preserves [REMOTE: ...] badge");
    assert.ok(narrowPlain.includes("Ctrl+C"), "Narrow 60-col dock preserves Ctrl+C confirmation hint over rightStatus");
    for (const l of narrowLines) assert.ok(visibleWidth(l) <= 60, `Narrow dock line overflow: ${visibleWidth(l)}`);

    // 6. Astra final P1 regressions: claudeOptionMatchesExactModel must not match contradictory stale display text,
    //    and unpinned outbox rows targeting a configured outbound alias must not deliver to an unrelated inbound peer.
    const { claudeOptionMatchesExactModel } = await import("../src/runners/acp-shims.js");
    const contradictoryOpt = { value: "opus", name: "Opus 4.7", description: "Resolved to claude-opus-5-5" };
    assert.equal(claudeOptionMatchesExactModel(contradictoryOpt, "claude-opus-5-5"), true);
    assert.equal(claudeOptionMatchesExactModel(contradictoryOpt, "claude-opus-4-7"), false);

    const db2 = new Database(":memory:");
    const store2 = new SessionMessageStore(db2);
    store2.enqueueOutbound({
      fromNode: "node-local",
      fromHost: "laptop",
      fromSessionId: "chat-1",
      toNode: null,
      toHost: "gpu-box",
      toSessionId: "chat-1",
      body: "unpinned-for-configured-alias",
    });
    const configured = new Set(["gpu-box"]);
    // Unrelated inbound peer claiming hostName "gpu-box" MUST NOT receive unpinned rows for configured outbound alias "gpu-box"
    assert.equal(
      store2.listQueuedOutboundForPeer({ alias: "gpu-box", direction: "inbound", hostName: "gpu-box", nodeId: "node-evil", configuredAliases: configured }).length,
      0,
    );
    assert.equal(
      store2.listQueuedOutboundForPeer({ alias: "gpu-box", direction: "outbound", hostName: "gpu-box", nodeId: "node-real", configuredAliases: configured }).length,
      1,
    );
    db2.close();
  });

  it("refuses to stop or overwrite a busy older-protocol daemon (P0-1) and rejects SSH option injection on DaemonClient (P1-3)", async () => {
    // P1-3: DaemonClient validates SSH targets before spawning ssh
    const badClient = new DaemonClient("ssh://-oProxyCommand=id");
    await assert.rejects(() => badClient.connect(), /Invalid SSH hostname/i);

    // P0-1: Fake busy protocolRev=7 daemon listening on a Unix socket
    const dir = realpathSync(mkdtempSync("/tmp/pi-busy-rev7-"));
    const sockPath = join(dir, "busy.sock");
    let shutdownCount = 0;
    const fakeServer = createServer((socket) => {
      attachDaemonReader(socket, {
        onMessage: (raw) => {
          const req = raw as { kind?: string; id?: string; op?: string };
          if (req?.kind !== "req" || !req.id) return;
          if (req.op === "ping") {
            writeDaemonMessage(socket, {
              kind: "res",
              id: req.id,
              ok: true,
              result: { pong: true, pid: 99999, protocolRev: 7, running: true, liveWork: "1 active agent task" },
            });
          } else if (req.op === "daemon.shutdown") {
            shutdownCount++;
            writeDaemonMessage(socket, { kind: "res", id: req.id, ok: true, result: { shuttingDown: true } });
          }
        },
        onError: () => {},
        onEnd: () => {},
      });
    });
    await new Promise<void>((resolve) => fakeServer.listen(sockPath, resolve));
    try {
      await assert.rejects(() => ensureLocalDaemon(sockPath), /has active or unknown work.*protocol rev 8/i);
      assert.equal(shutdownCount, 0, "Busy older-rev daemon must never receive daemon.shutdown");

      // Defense in depth: HarnessDaemon.start() also refuses to unlink a live listening socket
      const cfg = withFixtureCatalog({ ...loadConfig(dir), stateDir: dir, socketPath: sockPath });
      const rival = new HarnessDaemon(cfg, { dbPath: ":memory:" });
      try {
        await assert.rejects(() => rival.start(), /already listening/i);
      } finally {
        await rival.stop().catch(() => {});
      }
    } finally {
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
