import { spawn } from "node:child_process";
import { once } from "node:events";
import { DEFAULT_ORG_ID, asc, changePlans, eq, planSteps, servers, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { expandPlan, type ChangePlan } from "@jules/devops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devopsBench, type DevopsBench } from "./devops-harness.js";
import { eventually } from "./harness.js";

// DoD M7 : si le worker est tué au milieu d'un plan, le plan passe en `interrupted` et aucune étape
// n'est relancée seule (ARCHITECTURE.md §9 et §17).

let t: TestDatabase;
let bench: DevopsBench;

beforeAll(async () => {
  t = await startTestDatabase();
  bench = devopsBench(t.db);
}, 600_000);
afterAll(async () => {
  await bench.stop();
  await t.stop();
});

describe("worker tué au milieu d'un plan", () => {
  it("déclare le plan interrompu, rend le verrou, bloque la tâche et ne relance rien", async () => {
    const repo = await bench.repo();
    const { server, host } = await bench.addServer({
      name: "web-1",
      environment: "staging",
      level: "D3",
      repoId: repo.id,
    });
    const [task] = await t.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId: repo.id,
        agent: "devops",
        issueNumber: 7100,
        title: "Migration",
        request: "@jules devops migre",
        state: "executing",
      })
      .returning();
    const plan: ChangePlan = {
      goal: "trois étapes",
      server: server.name,
      environment: "staging",
      actions: [
        { kind: "command", command: "touch /tmp/etape-1", reason: "1" },
        { kind: "command", command: "sleep 4", reason: "2" },
        { kind: "command", command: "touch /tmp/etape-3", reason: "3" },
      ],
      impact: "aucun",
      verify: ["test -e /tmp/etape-3"],
      rollback: ["rm -f /tmp/etape-1"],
    };
    const expanded = expandPlan(plan, { serverEnvironment: "staging", playbooks: {} });
    if (!expanded.ok) throw new Error(expanded.problems.join());
    const row = await t.db.transaction((tx) =>
      bench.plans.submit(tx, {
        server,
        plan,
        steps: expanded.steps,
        approvalRequired: false,
        taskId: task!.id,
      }),
    );

    // Un vrai processus worker, tué net pendant l'étape 2.
    const child = spawn(
      process.execPath,
      ["--conditions=@jules/source", "--import", "tsx", "test/fixtures/plan-runner.ts"],
      {
        env: { ...process.env, DATABASE_URL: t.url, JULES_MASTER_KEY: bench.masterKey },
        stdio: "ignore",
      },
    );
    const stepsOf = () =>
      t.db
        .select()
        .from(planSteps)
        .where(eq(planSteps.planId, row.id))
        .orderBy(asc(planSteps.position));
    await eventually(
      async () => ((await stepsOf())[1]?.status === "running" ? true : undefined),
      60_000,
    );
    child.kill("SIGKILL");
    await once(child, "exit");

    // Redémarrage : un nouveau worker reprend.
    expect(await bench.plans.recover()).toBe(1);
    const [interrupted] = await t.db.select().from(changePlans).where(eq(changePlans.id, row.id));
    expect(interrupted).toMatchObject({
      status: "interrupted",
      failureReason: expect.stringContaining("étape 2 (sleep 4)"),
    });
    expect((await stepsOf()).map((s) => s.status)).toEqual([
      "done",
      "running",
      "pending",
      "pending",
      "pending",
    ]);
    const [unlocked] = await t.db.select().from(servers).where(eq(servers.id, server.id));
    expect(unlocked?.lockPlanId).toBeNull();
    const [blocked] = await t.db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(blocked).toMatchObject({ state: "blocked", resumeState: "diagnosing" });

    // Rien n'est relancé, même après la fin de la commande coupée sur le serveur.
    expect(await bench.plans.drain()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const listing = await host.exec("ls /tmp");
    expect(listing).toContain("etape-1");
    expect(listing).not.toContain("etape-3");
  });
});
