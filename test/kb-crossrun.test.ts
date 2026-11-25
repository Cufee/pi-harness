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
import { runGit, WorktreeManager } from "../src/worktree/manager.js";
import { BisectingMergeQueue } from "../src/worktree/merge-queue.js";

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
      /not permitted for Tier 2|\[harness blocked: not-your-tool\]/,
    );

    db.close();
  });

  it("applies friendly-ID mutations (KB_1, 1, kb-1) to canonical DB rows across getMany, promote, flagStale, and archive", () => {
    const db = new ControlPlaneDb(":memory:");
    const repoScope = "/repo/friendly-ids";

    const e1 = db.kb.propose({
      repoScope,
      kind: "invariant",
      title: "Idempotent webhooks",
      summary: "All webhook handlers must deduplicate by event ID",
      contextMd: "Checked in src/webhooks/handler.ts.",
      pathGlobs: ["src/webhooks/**"],
      evidencePaths: ["src/webhooks/handler.ts"],
      verifiedSha: "abc1234",
    });
    const e2 = db.kb.propose({
      repoScope,
      kind: "invariant",
      title: "Idempotent webhooks v2",
      summary: "Webhook dedup now uses SQLite unique index",
      contextMd: "Checked in src/webhooks/store.ts.",
      pathGlobs: ["src/webhooks/**"],
      evidencePaths: ["src/webhooks/store.ts"],
      verifiedSha: "def5678",
      status: "active",
      confidence: "verified",
    });
    assert.equal(e1.id, "kb-1");
    assert.equal(e2.id, "kb-2");

    // promote via non-canonical "KB_1"
    const promoted = db.kb.promote("KB_1", { verifiedSha: "abc1234" });
    assert.equal(promoted.id, "kb-1");
    assert.equal(promoted.status, "active");
    assert.equal(db.kb.getRaw("kb-1")?.status, "active");

    // getMany via bare numeric "1" and mixed-case "KB_1" persists hit_count in DB
    const firstRead = db.kb.getMany(["1"]);
    assert.equal(firstRead.length, 1);
    assert.equal(firstRead[0]?.hitCount, 1);
    assert.equal(db.kb.getRaw("kb-1")?.hitCount, 1);

    const secondRead = db.kb.getMany(["KB_1"]);
    assert.equal(secondRead[0]?.hitCount, 2);
    assert.equal(db.kb.getRaw("kb-1")?.hitCount, 2);

    // flagStale via bare numeric "1" persists stale status and reason
    const staled = db.kb.flagStale("1", "handler refactored");
    assert.equal(staled.status, "stale");
    assert.equal(db.kb.getRaw("kb-1")?.status, "stale");
    assert.equal(db.kb.getRaw("kb-1")?.staleReason, "handler refactored");

    // archive via "KB_1" (and friendly supersededBy "2") persists archived status + canonical supersededBy
    const archived = db.kb.archive("KB_1", { reason: "Superseded by v2", supersededBy: "2" });
    assert.equal(archived.status, "archived");
    assert.equal(db.kb.getRaw("kb-1")?.status, "archived");
    assert.equal(db.kb.getRaw("kb-1")?.supersededBy, "kb-2");

    db.close();
  });

  it("does not starve newly added scoped invariants or filtered kinds when a repo has 30+ active KB entries", () => {
    const db = new ControlPlaneDb(":memory:");
    const repoScope = "/repo/large-kb";

    // Seed 32 high-hit-count active invariants in src/auth/**
    for (let i = 1; i <= 32; i++) {
      const entry = db.kb.propose({
        repoScope,
        kind: "invariant",
        title: `Auth rule ${i}`,
        summary: `Auth invariant number ${i}`,
        contextMd: `Details for auth invariant ${i}.`,
        tags: ["auth"],
        pathGlobs: ["src/auth/**"],
        evidencePaths: [`src/auth/rule-${i}.ts`],
        status: "active",
        confidence: "verified",
      });
      // Give each auth invariant higher hit_count than the newly added payments invariant
      db.kb.getMany([entry.id, entry.id, entry.id]);
    }

    // Add a brand-new 0-hit-count active invariant for src/payments/**
    const paymentsInvariant = db.kb.propose({
      repoScope,
      kind: "invariant",
      title: "Payments ledger double-entry",
      summary: "Every charge must write balanced debit and credit rows",
      contextMd: "Enforced in src/payments/ledger.ts.",
      tags: ["payments", "ledger"],
      pathGlobs: ["src/payments/**"],
      evidencePaths: ["src/payments/ledger.ts"],
      status: "active",
      confidence: "verified",
    });

    // Also add a convention entry to verify SQL kind pushdown isn't starved by 33 invariants
    const convention = db.kb.propose({
      repoScope,
      kind: "convention",
      title: "Error code naming",
      summary: "Prefix exported error codes with ERR_",
      contextMd: "Used across API handlers.",
      tags: ["errors"],
      pathGlobs: ["src/**"],
      evidencePaths: [],
      status: "active",
      confidence: "verified",
    });

    // Stage 0 ambient index (limit=5) must NOT starve the 0-hit payments invariant behind 32 auth entries
    const ambient = db.kb.getScopedAmbientIndex(repoScope, ["src/payments/**"], 5);
    assert.equal(ambient.length, 1);
    assert.equal(ambient[0]?.id, paymentsInvariant.id);

    // Structured tag search with small limit must also find the payments invariant
    const byTag = db.kb.search({ repoScope, tags: ["ledger"], limit: 5 });
    assert.equal(byTag.length, 1);
    assert.equal(byTag[0]?.id, paymentsInvariant.id);

    // Kind filter pushed into SQL must return convention even with 33 invariants ahead of it
    const conventions = db.kb.search({ repoScope, kinds: ["convention"], limit: 5 });
    assert.equal(conventions.length, 1);
    assert.equal(conventions[0]?.id, convention.id);

    db.close();
  });

  it("auto-runs $0 KnowledgeMaintainer pre-check after clean BisectingMergeQueue merge and flags modified evidence as stale", async () => {
    const { dir: repo, sha: baseSha } = await makeTempRepo();
    const nonGitDir = mkdtempSync(join(tmpdir(), "pi-harness-nongit-"));
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 });
      const { baseBranch } = await mgr.resolveRepoInfo();

      const authEntry = db.kb.propose({
        repoScope: repo,
        kind: "invariant",
        title: "Auth uses cookie mode",
        summary: "auth.ts enforces cookie sessions",
        contextMd: "Verified at base commit.",
        pathGlobs: ["auth.ts"],
        evidencePaths: ["auth.ts"],
        verifiedSha: baseSha,
        status: "active",
        confidence: "verified",
      });
      const untouchedEntry = db.kb.propose({
        repoScope: repo,
        kind: "gotcha",
        title: "Legacy module quirk",
        summary: "legacy.ts exports old=true",
        contextMd: "Verified at base commit.",
        pathGlobs: ["legacy.ts"],
        evidencePaths: ["legacy.ts"],
        verifiedSha: baseSha,
        status: "active",
        confidence: "verified",
      });

      const run = db.createRun({ goal: "Migrate auth to JWT", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Switch auth.ts to JWT",
        objective: "Modify auth.ts",
        profileId: "acp:claude",
      });
      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);

      writeFileSync(join(wt.path, "auth.ts"), "export const mode = 'jwt';\n", "utf8");
      await runGit(wt.path, ["add", "auth.ts"]);
      await runGit(wt.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "switch auth to jwt"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, {});
      db.enqueueMerge({ runId: run.id, taskId: worker.id, worktreeId: wt.id, branch: wt.branch });
      const outcome = await mq.processNext(run.id);

      assert.equal(outcome?.item.status, "merged");
      assert.ok(outcome?.mergedSha);

      // Active KB entry anchored on auth.ts must be automatically flagged stale by the post-merge pre-check
      const refreshedAuth = db.kb.getRaw(authEntry.id);
      assert.equal(refreshedAuth?.status, "stale");
      assert.match(refreshedAuth?.staleReason ?? "", /evidence_modified: auth\.ts/);

      // Untouched KB entry must remain active and marked clean at mergedSha
      const refreshedLegacy = db.kb.getRaw(untouchedEntry.id);
      assert.equal(refreshedLegacy?.status, "active");
      assert.equal(refreshedLegacy?.lastCheckedSha, outcome?.mergedSha);

      // Maintainer pre-check is safe on non-git dirs and prompt accurately names all real KB tools
      const maintainer = new KnowledgeMaintainer(db.kb);
      const nonGitReport = await maintainer.runDeterministicPreCheck(nonGitDir, repo);
      assert.equal(nonGitReport.headSha, "");
      assert.equal(nonGitReport.staleMarked, 0);
      assert.equal(nonGitReport.candidatesPending, 0);
      assert.equal(nonGitReport.shouldSpawnMaintainer, true);

      const prompt = maintainer.buildMaintainerPrompt(nonGitReport);
      for (const toolName of ["kb_search", "kb_get", "kb_promote", "kb_flag_stale", "kb_archive"]) {
        assert.ok(prompt.includes(toolName), `Maintainer prompt must name tool ${toolName}`);
      }

      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
