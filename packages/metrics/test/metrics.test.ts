import { appendAudit } from "@jules/audit";
import {
  DEFAULT_ORG_ID,
  installations,
  repos,
  artifacts,
  commands,
  eq,
  tasks,
  type Db,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeMetrics, promotionAdvice, renderMetrics } from "../src/metrics.js";

async function seedTask(db: Db) {
  const [installation] = await db
    .insert(installations)
    .values({
      orgId: DEFAULT_ORG_ID,
      githubInstallationId: 4242,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { accountLogin: "acme" },
    })
    .returning();
  const [repo] = await db
    .insert(repos)
    .values({
      orgId: DEFAULT_ORG_ID,
      forge: "github",
      installationId: installation!.id,
      githubRepoId: 99,
      fullName: "acme/sandbox",
      defaultBranch: "main",
      private: true,
    })
    .onConflictDoUpdate({
      target: [repos.forge, repos.githubRepoId],
      set: { fullName: "acme/sandbox" },
    })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      agent: "developer",
      issueNumber: Math.floor(Math.random() * 1e6),
      title: "t",
      request: "r",
    })
    .returning();
  return { task: task! };
}

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
