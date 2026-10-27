import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "@jules/audit";
import { DEFAULT_ORG_ID, artifacts, commands, eq, events, outbox, repos, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareEvals, scoreTask } from "../src/evals.js";
import { computeMetrics, promotionAdvice, renderMetrics } from "../src/metrics.js";
import { TRANSCRIPTS_DIR, purgeExpired } from "../src/retention.js";
import { seedTask } from "./harness.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});

const gates = (fail: boolean) => ({
  commit: "x",
  results: [
    { id: "G5.5", name: "Tests", status: fail ? "fail" : "pass", durationMs: 0, details: "" },
  ],
});

describe("métriques (WORKFLOW.md §10)", () => {
  it("calcule l'acceptation, le coût par PR mergée et les gates au premier essai", async () => {
    const since = new Date(Date.now() - 3600_000);
    const make = async (opts: {
      merged?: boolean;
      firstGatesFail?: boolean;
      cost: string;
      fix?: boolean;
    }) => {
      const { task } = await seedTask(t.db);
      await t.db
        .update(tasks)
        .set({ prNumber: 1, costUsd: opts.cost, reviewRounds: 1 })
        .where(eq(tasks.id, task.id));
      await t.db.insert(artifacts).values({
        orgId: DEFAULT_ORG_ID,
        taskId: task.id,
        kind: "gate_report",
        version: 1,
        content: gates(opts.firstGatesFail ?? false),
      });
      if (opts.merged !== undefined) {
        await t.db.insert(artifacts).values({
          orgId: DEFAULT_ORG_ID,
          taskId: task.id,
          kind: "pr_closed",
          version: 1,
          content: { merged: opts.merged },
        });
      }
      if (opts.fix) {
        await t.db.insert(artifacts).values({
          orgId: DEFAULT_ORG_ID,
          taskId: task.id,
          kind: "human_input",
          version: 1,
          content: { kind: "fix", text: "x" },
        });
        await t.db.insert(commands).values({
          orgId: DEFAULT_ORG_ID,
          taskId: task.id,
          source: "github",
          name: "fix",
          args: {},
          decision: "applied",
          reason: "",
        });
      }
      await appendAudit(t.db, {
        orgId: DEFAULT_ORG_ID,
        actor: { type: "system", id: "test" },
        action: "task.transition",
        target: { type: "task", id: task.id },
        data: { to: "awaiting_human_review" },
      });
      return task;
    };
    await make({ merged: true, cost: "4" });
    await make({ merged: true, cost: "2", firstGatesFail: true, fix: true });
    await make({ merged: false, cost: "3" });
    await make({ cost: "1" });

    const [m] = await computeMetrics(t.db, { since, until: new Date(Date.now() + 1000) });

    expect(m).toMatchObject({
      repo: "acme/sandbox",
      tasks: 4,
      prsOpened: 4,
      merged: 2,
      closedWithoutMerge: 1,
      acceptanceRate: 0.5,
      mergedWithoutRetouch: 1,
      firstTryGateRate: 0.75,
      totalCostUsd: 10,
      costPerMergedPr: 5,
    });
    expect(m?.avgReviewRounds).toBe(1.25);
    expect(m?.avgHoursToReady).toBeGreaterThanOrEqual(0);
    const report = renderMetrics([m!], { since, until: new Date() });
    expect(report).toContain("taux d'acceptation 50 %");
    expect(report).toContain("coût par PR mergée 5,00 $");
    expect(report).toContain("gates au premier essai 75 %");
    expect(renderMetrics([], { since, until: new Date() })).toContain("aucune tâche");
  });

  it("propose la promotion L1 → L2 selon la règle", () => {
    expect(promotionAdvice({ autonomy: "L1", tasks: 20, acceptanceRate: 0.8 })).toContain(
      "L1 → L2",
    );
    expect(promotionAdvice({ autonomy: "L1", tasks: 19, acceptanceRate: 1 })).toBeNull();
    expect(promotionAdvice({ autonomy: "L2", tasks: 50, acceptanceRate: 1 })).toBeNull();
  });
});

describe("rétention (ARCHITECTURE.md §18)", () => {
  it("purge les payloads, les transcriptions et les dossiers d'exécution expirés", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const [expired] = await t.db
      .insert(events)
      .values({
        orgId: DEFAULT_ORG_ID,
        deliveryId: crypto.randomUUID(),
        event: "issues",
        payload: { x: 1 },
        status: "processed",
        receivedAt: old,
      })
      .returning();
    const [recent] = await t.db
      .insert(events)
      .values({
        orgId: DEFAULT_ORG_ID,
        deliveryId: crypto.randomUUID(),
        event: "issues",
        payload: { x: 1 },
        status: "processed",
      })
      .returning();
    const runsDir = mkdtempSync(join(tmpdir(), "jules-retention-"));
    const age = (path: string, days: number) => {
      const when = new Date(Date.now() - days * 86_400_000);
      utimesSync(path, when, when);
    };
    mkdirSync(join(runsDir, TRANSCRIPTS_DIR));
    writeFileSync(join(runsDir, TRANSCRIPTS_DIR, "old.jsonl"), "{}");
    age(join(runsDir, TRANSCRIPTS_DIR, "old.jsonl"), 100);
    writeFileSync(join(runsDir, TRANSCRIPTS_DIR, "new.jsonl"), "{}");
    for (const name of ["old-run", "pending-run", "fresh-run"]) {
      mkdirSync(join(runsDir, name, "pristine.git"), { recursive: true });
      age(join(runsDir, name), name === "fresh-run" ? 1 : 10);
    }
    await t.db.insert(outbox).values({
      orgId: DEFAULT_ORG_ID,
      kind: "git.push",
      idempotencyKey: crypto.randomUUID(),
      payload: { pristineDir: join(runsDir, "pending-run", "pristine.git") },
    });

    expect(await purgeExpired(t.db, { runsDir })).toEqual({
      eventPayloads: 1,
      transcripts: 1,
      workDirs: 1,
    });

    expect((await t.db.select().from(events).where(eq(events.id, expired!.id)))[0]).toMatchObject({
      payload: null,
      deliveryId: expired!.deliveryId,
    });
    expect((await t.db.select().from(events).where(eq(events.id, recent!.id)))[0]?.payload).toEqual(
      { x: 1 },
    );
    expect(existsSync(join(runsDir, "old-run"))).toBe(false);
    expect(existsSync(join(runsDir, "pending-run"))).toBe(true);
    expect(existsSync(join(runsDir, "fresh-run"))).toBe(true);
    expect(existsSync(join(runsDir, TRANSCRIPTS_DIR, "new.jsonl"))).toBe(true);
    expect(repos).toBeDefined();
  });
});

describe("score des evals", () => {
  const review = {
    verdict: "approve" as const,
    summary: "ok",
    acVerdicts: [{ ac: "AC-1", status: "met" as const, note: "" }],
    findings: [],
  };

  it("donne 100 à une tâche parfaite et gratuite, et plafonne une tâche non livrée", () => {
    expect(
      scoreTask({
        state: "awaiting_human_review",
        gates: gates(false) as never,
        review,
        acCount: 1,
        costUsd: 0,
        budgetUsd: 10,
      }).score,
    ).toBe(100);
    expect(
      scoreTask({
        state: "blocked",
        gates: gates(false) as never,
        review,
        acCount: 1,
        costUsd: 0,
        budgetUsd: 10,
      }).score,
    ).toBe(10);
    expect(
      scoreTask({
        state: "awaiting_human_review",
        gates: gates(true) as never,
        acCount: 2,
        costUsd: 10,
        budgetUsd: 10,
      }).score,
    ).toBe(0);
  });

  it("compare avec une tolérance", () => {
    const run = (score: number) => ({
      label: "x",
      total: score,
      tasks: [
        {
          id: "a",
          score,
          state: "done",
          details: { gates: 0, criteria: 0, review: 0, cost: 0, costUsd: 0 },
        },
      ],
    });
    expect(compareEvals(run(80), run(79)).ok).toBe(true);
    expect(compareEvals(run(80), run(70))).toMatchObject({
      ok: false,
      delta: -10,
      regressions: ["a : 80 → 70"],
    });
  });
});
