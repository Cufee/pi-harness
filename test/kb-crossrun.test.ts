import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { KnowledgeMaintainer } from "../src/kb/maintainer.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";

async function makeTempRepo(): Promise<{ dir: string; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-kb-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "auth.ts"), "export const mode = 'cookie';\n", "utf8");
  writeFileSync(join(dir, "legacy.ts"), "export const old = true;\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const { stdout: sha } = await runGit(dir, ["rev-parse", "HEAD"]);
  return { dir, sha };
}

describe("Knowledge Base (FTS5 + Deterministic Git Pre-Check) & Cross-Run Coordination", () => {
  it("supports 2-stage FTS5 + glob discovery, hit telemetry, and $0-token git diff staleness detection", async () => {
    const { dir, sha } = await makeTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const e1 = db.kb.propose({
        repoScope: dir,
        kind: "invariant",
        title: "Auth uses cookie mode",
        summary: "auth.ts enforces cookie session mode",
        contextMd: "Verified in auth.ts line 1 during initial audit.",
        tags: ["auth", "session"],
        pathGlobs: ["auth.ts"],
        evidencePaths: ["auth.ts"],
        verifiedSha: sha,
      });
      const e2 = db.kb.propose({
        repoScope: dir,
        kind: "gotcha",
        title: "Legacy module quirk",
        summary: "legacy.ts must not be imported directly",
        contextMd: "Legacy flag breaks cold boot.",
        tags: ["legacy"],
        pathGlobs: ["legacy.ts"],
        evidencePaths: ["legacy.ts"],
        verifiedSha: sha,
      });

      // Candidates stay hidden from default Stage 1 search until Maintainer promotes them
      assert.equal(db.kb.search({ query: "cookie", repoScope: dir }).length, 0);
      assert.equal(db.kb.search({ query: "cookie", repoScope: dir, includeCandidates: true }).length, 1);

      db.kb.promote(e1.id, { verifiedSha: sha });
      db.kb.promote(e2.id, { verifiedSha: sha });

      // Stage 1 card search + Stage 2 on-demand get increments hitCount
      const cards = db.kb.search({ query: "cookie", repoScope: dir, pathGlobs: ["auth.ts"] });
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.id, e1.id);

      const full = db.kb.getMany([e1.id]);
      assert.equal(full[0]?.hitCount, 1);
      assert.match(full[0]?.contextMd ?? "", /initial audit/);

      // Deterministic pre-check at unchanged HEAD: zero dirty entries, no Maintainer spawn needed!
      const maintainer = new KnowledgeMaintainer(db.kb);
      const cleanReport = await maintainer.runDeterministicPreCheck(dir);
      assert.equal(cleanReport.shouldSpawnMaintainer, false);

      // Modify auth.ts and delete legacy.ts -> commit
      writeFileSync(join(dir, "auth.ts"), "export const mode = 'jwt';\n", "utf8");
      unlinkSync(join(dir, "legacy.ts"));
      await runGit(dir, ["add", "-A"]);
      await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "migrate to jwt & delete legacy"]);

      // Reset lastCheckedSha to simulate new commits since last check
      const dirtyReport = await maintainer.runDeterministicPreCheck(dir);
      assert.equal(dirtyReport.shouldSpawnMaintainer, true);
      assert.equal(dirtyReport.dirtyEntries.length, 2);
      assert.equal(db.kb.getRaw(e2.id)?.status, "stale", "Deleted evidence must auto-flag entry as stale");
      assert.match(db.kb.getRaw(e2.id)?.staleReason ?? "", /evidence_deleted/);

      // Bi-temporal archival preserves superseded_by lineage
      const replacement = db.kb.propose({
        repoScope: dir,
        kind: "invariant",
        title: "Auth uses JWT mode",
        summary: "auth.ts migrated to JWT bearer tokens",
        contextMd: "Replaced cookie mode.",
        pathGlobs: ["auth.ts"],
        evidencePaths: ["auth.ts"],
        verifiedSha: dirtyReport.headSha,
        status: "active",
        confidence: "verified",
      });
      db.kb.archive(e1.id, { reason: "Migrated to JWT", supersededBy: replacement.id });
      assert.equal(db.kb.getRaw(e1.id)?.supersededBy, replacement.id);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces cross-run repo write-leases, versioned frozen contracts, Tier-1-only boundary, max_rounds, and DFS deadlock detection", async () => {
    const db = new ControlPlaneDb(":memory:");
    const runA = db.createRun({
      goal: "Backend API",
      repoRoot: "/repo/mono",
      baseBranch: "main",
      baseSha: "aaa",
      coordinationGroup: "checkout-v2",
      isolationMode: "coordinated",
    });
    const runB = db.createRun({
      goal: "Frontend SDK",
      repoRoot: "/repo/mono",
      baseBranch: "main",
      baseSha: "aaa",
      coordinationGroup: "checkout-v2",
      isolationMode: "coordinated",
    });

    const orchA = db.createTask({
      runId: runA.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch A",
      objective: "Backend",
      readOnly: true,
      profileId: "acp:claude",
    });
    const orchB = db.createTask({
      runId: runB.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch B",
      objective: "Frontend",
      readOnly: true,
      profileId: "acp:codex",
    });

    // Cross-run write-scope lease collision on same (repo_root, target_branch) is blocked!
    db.createTask({
      runId: runA.id,
      parentId: orchA.id,
      tier: 2,
      kind: "worker",
      title: "Shared types",
      objective: "Edit shared",
      profileId: "acp:claude",
      writeScopes: ["packages/shared/**"],
    });
    assert.throws(
      () =>
        db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Also touch shared",
          objective: "Overlap",
          profileId: "acp:codex",
          writeScopes: ["packages/shared/order.ts"],
        }),
      /Write-scope conflict/,
    );

    // Versioned single-writer contracts + freeze semantics
    const v1 = db.publishContract({
      namespace: "group:checkout-v2",
      key: "orders.schema",
      ownerRunId: runA.id,
      payload: { orderId: "string" },
      summary: "Initial order schema",
      status: "draft",
    });
    assert.equal(v1.version, 1);

    // Run B cannot overwrite Run A's contract
    assert.throws(
      () =>
        db.publishContract({
          namespace: "group:checkout-v2",
          key: "orders.schema",
          ownerRunId: runB.id,
          payload: { orderId: "number" },
          summary: "Hijack",
        }),
      /owned by run/,
    );

    // Run A freezes v2; subsequent draft edits rejected
    const v2 = db.publishContract({
      namespace: "group:checkout-v2",
      key: "orders.schema",
      ownerRunId: runA.id,
      payload: { orderId: "string", currency: "USD" },
      summary: "Frozen order schema",
      status: "frozen",
      expectedVersion: 1,
    });
    assert.equal(v2.version, 2);
    assert.throws(
      () =>
        db.publishContract({
          namespace: "group:checkout-v2",
          key: "orders.schema",
          ownerRunId: runA.id,
          payload: { broken: true },
          summary: "Break frozen",
        }),
      /FROZEN/,
    );

    // Transactional DFS deadlock cycle detection: A waits on B -> B trying to wait on A throws ERR_CROSS_RUN_DEADLOCK
    const req1 = db.createPeerRequest({
      fromRunId: runA.id,
      toRunId: runB.id,
      topicKey: "sdk-field",
      message: "Confirm field name?",
    });
    assert.throws(
      () =>
        db.createPeerRequest({
          fromRunId: runB.id,
          toRunId: runA.id,
          topicKey: "api-field",
          message: "Wait on you first!",
        }),
      /ERR_CROSS_RUN_DEADLOCK/,
    );

    // Reply clears wait edge; round 2 succeeds; round 3 hits max_rounds=2
    db.replyPeerRequest(req1.id, runB.id, "Confirmed!");
    const req2 = db.createPeerRequest({
      fromRunId: runA.id,
      toRunId: runB.id,
      topicKey: "sdk-field",
      message: "Round 2 follow-up",
    });
    db.replyPeerRequest(req2.id, runB.id, "Ack");
    assert.throws(
      () =>
        db.createPeerRequest({
          fromRunId: runA.id,
          toRunId: runB.id,
          topicKey: "sdk-field",
          message: "Round 3 ping-pong",
        }),
      /ERR_CROSS_RUN_MAX_ROUNDS/,
    );

    // Strict Tier-1-only enforcement on cross-run tools
    const workerA = db.listTasks(runA.id).find((t) => t.tier === 2)!;
    const config = loadConfig();
    const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config), new QuotaClient());
    await assert.rejects(
      () => orch.toolExecutor.execute(runA.id, workerA.id, "list_peer_runs", {}),
      /not permitted for Tier 2/,
    );

    db.close();
  });
});
