import { execFileSync } from "node:child_process";
import {
  DEFAULT_ORG_ID,
  changePlans,
  eq,
  inArray,
  installations,
  outbox,
  planSteps,
  repos,
  runs,
  tasks,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { expandPlan, type ChangePlan } from "@jules/devops";
import type { RunOutcome, RunSpec } from "@jules/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlanService } from "../src/devops/plans.js";
import type { ServerRow } from "../src/devops/servers.js";
import { drainOutbox } from "../src/outbox.js";
import { SSH_KEYS, devopsBench, type DevopsBench } from "./devops-harness.js";
import { startFakeModel, type FakeModel, type Step } from "./fake-model.js";
import { testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { bareRemote, sandboxSetup } from "./sandbox-harness.js";

// Tests de charge de M11 (ROADMAP.md) : plusieurs tâches et plusieurs serveurs en même temps.
// Les vraies exécutions (binaire Claude Code dans le sandbox), les vrais serveurs OpenSSH, la vraie base.

let t: TestDatabase;
let model: FakeModel;
const benches: DevopsBench[] = [];

const BUILD: Step[] = [
  {
    tool: "Write",
    input: {
      file_path: "/workspace/health.js",
      content: "export const health = () => ({ ok: true });\n",
    },
  },
  {
    tool: "mcp__jules__submit_build",
    input: { summary: "Ajoute /healthz.", commitMessage: "feat(api): ajoute /healthz" },
  },
  { text: "Terminé." },
];

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
  // Après le développement, les tâches passent la vérification puis la review du second modèle.
  model = await startFakeModel({
    build: BUILD,
    review: [
      {
        tool: "mcp__jules__submit_review",
        input: { verdict: "approve", summary: "ok", acVerdicts: [] },
      },
      { text: "Terminé." },
    ],
  });
}, 900_000);
afterAll(async () => {
  await Promise.all(benches.map((b) => b.stop()));
  await model.close();
  await t.stop();
});

describe("charge (M11)", () => {
  it("six tâches sur trois repos : trois exécutions à la fois, ni doublon, ni effet perdu", async () => {
    const MAX = 3;
    const s = sandboxSetup(t.db, model, { maxConcurrentRuns: MAX });
    // Compte les exécutions d'agent en cours (celles qui portent un jeton de run).
    let active = 0;
    let peak = 0;
    const run = s.driver.run.bind(s.driver);
    s.driver.run = async (spec: RunSpec): Promise<RunOutcome> => {
      const agent = Boolean(spec.env?.JULES_RUN_TOKEN);
      if (agent) peak = Math.max(peak, ++active);
      try {
        return await run(spec);
      } finally {
        if (agent) active -= 1;
      }
    };
    const [installation] = await t.db
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
    const created: string[] = [];
    for (let r = 0; r < 3; r++) {
      const name = `charge-${r}`;
      s.github.remotes.set(`acme/${name}`, bareRemote());
      const [repo] = await t.db
        .insert(repos)
        .values({
          orgId: DEFAULT_ORG_ID,
          forge: "github",
          installationId: installation!.id,
          githubRepoId: 5000 + r,
          fullName: `acme/${name}`,
          defaultBranch: "main",
          private: true,
          autonomy: "L2",
        })
        .returning();
      for (let i = 0; i < 2; i++) {
        const [task] = await t.db
          .insert(tasks)
          .values({
            orgId: DEFAULT_ORG_ID,
            repoId: repo!.id,
            agent: "developer",
            issueNumber: 100 + r * 10 + i,
            title: `Charge ${r}.${i}`,
            request: "@jules ajoute un endpoint /healthz",
            state: "building",
            autonomy: "L2",
            type: "bug",
            size: "S",
            risk: "low",
            language: "fr",
          })
          .returning();
        created.push(task!.id);
      }
    }

    const started = Date.now();
    const deps = testDeps(t.db, s.github);
    const states = async () =>
      (await t.db.select({ state: tasks.state }).from(tasks).where(inArray(tasks.id, created))).map(
        (r) => r.state,
      );
    // Comme la boucle du worker : on remplit les places libres dès qu'une exécution se termine.
    while (Date.now() - started < 600_000) {
      await s.orchestrator.drainTasks();
      await drainOutbox(deps);
      if ((await states()).every((state) => state !== "building")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await s.orchestrator.idle();
    await drainOutbox(deps);
    const seconds = (Date.now() - started) / 1000;

    // Chaque tâche a dépassé le développement sans échec, plus ou moins loin selon son avance.
    const after = await t.db
      .select({ state: tasks.state, lastError: tasks.lastError })
      .from(tasks)
      .where(inArray(tasks.id, created));
    expect(
      after.filter((r) => !["verifying", "reviewing", "awaiting_human_review"].includes(r.state)),
    ).toEqual([]);
    expect(peak).toBe(MAX);
    // Une exécution de développement par tâche ; les reviews suivent selon l'avance de chacune.
    const agentRuns = (await t.db.select().from(runs).where(inArray(runs.taskId, created))).filter(
      (r) => r.role === "developer",
    );
    expect(agentRuns).toHaveLength(6);
    expect(agentRuns.every((r) => r.status === "succeeded")).toBe(true);
    // Une PR par tâche, chacune sur son repo et sa branche.
    const prs = s.github.pullRequests.filter((p) => p.repo.startsWith("acme/charge-"));
    expect(prs).toHaveLength(6);
    expect(new Set(prs.map((p) => `${p.repo}:${p.head}`)).size).toBe(6);
    for (let r = 0; r < 3; r++) {
      const branches = execFileSync("git", [
        "-C",
        s.github.remotes.get(`acme/charge-${r}`)!,
        "branch",
        "--list",
        "jules/*",
      ])
        .toString()
        .trim()
        .split("\n");
      expect(branches).toHaveLength(2);
    }
    const effects = await t.db.select().from(outbox);
    expect(effects.filter((e) => e.status !== "done")).toEqual([]);
    console.info(`charge : 6 tâches, ${MAX} exécutions à la fois, ${seconds.toFixed(1)} s`);
  }, 900_000);

  it("six plans sur trois serveurs et trois workers : en parallèle d'un serveur à l'autre, un à la fois par serveur", async () => {
    const bench = devopsBench(t.db);
    benches.push(bench);
    const repoId = (await bench.repo(6000, "acme/infra")).id;
    const hosts = await Promise.all(
      [0, 1, 2].map((i) =>
        bench.addServer({ name: `charge-${i}`, environment: "staging", level: "D1", repoId }),
      ),
    );
    const submit = (server: ServerRow, marker: string) => {
      const plan: ChangePlan = {
        goal: "charge",
        server: server.name,
        environment: "staging",
        actions: [
          {
            kind: "command",
            command: `sleep 1 && echo ${marker} >> /tmp/charge`,
            reason: "charge",
          },
        ],
        impact: "aucun",
        verify: [`grep -q ${marker} /tmp/charge`],
        rollback: ["true"],
      };
      const expanded = expandPlan(plan, { serverEnvironment: "staging", playbooks: {} });
      if (!expanded.ok) throw new Error(expanded.problems.join());
      return t.db.transaction((tx) =>
        bench.plans.submit(tx, { server, plan, steps: expanded.steps, approvalRequired: false }),
      );
    };
    const plans = [];
    for (const { server } of hosts) {
      plans.push(
        await submit(server, `${server.name}-a`),
        await submit(server, `${server.name}-b`),
      );
    }

    // Trois workers qui se disputent les serveurs.
    const workers = [
      bench.plans,
      ...[1, 2].map(() => new PlanService({ db: t.db, servers: bench.servers, log: bench.log })),
    ];
    const started = Date.now();
    for (let round = 0; round < 10; round++) {
      await Promise.all(workers.map((w) => w.drain()));
      const rows = await t.db
        .select()
        .from(changePlans)
        .where(
          inArray(
            changePlans.id,
            plans.map((p) => p.id),
          ),
        );
      if (rows.every((r) => r.status === "succeeded")) break;
    }
    const seconds = (Date.now() - started) / 1000;
    const rows = await t.db
      .select()
      .from(changePlans)
      .where(
        inArray(
          changePlans.id,
          plans.map((p) => p.id),
        ),
      );
    expect(rows.map((r) => r.status)).toEqual(plans.map(() => "succeeded"));

    // Un à la fois par serveur.
    for (const { server, host } of hosts) {
      const mine = rows
        .filter((r) => r.serverId === server.id)
        .sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime());
      expect(mine[1]!.startedAt!.getTime()).toBeGreaterThanOrEqual(mine[0]!.endedAt!.getTime());
      expect((await host.exec("cat /tmp/charge")).trim().split("\n").sort()).toEqual([
        `${server.name}-a`,
        `${server.name}-b`,
      ]);
    }
    // En parallèle d'un serveur à l'autre : au moins deux plans de serveurs différents se chevauchent.
    const overlaps = rows.some((a) =>
      rows.some(
        (b) =>
          a.serverId !== b.serverId &&
          a.startedAt!.getTime() < b.endedAt!.getTime() &&
          b.startedAt!.getTime() < a.endedAt!.getTime(),
      ),
    );
    expect(overlaps).toBe(true);
    // Chaque plan a son journal complet, et aucune clé n'apparaît dans les journaux du worker.
    const steps = await t.db
      .select()
      .from(planSteps)
      .where(
        inArray(
          planSteps.planId,
          plans.map((p) => p.id),
        ),
      );
    expect(steps.filter((st) => st.status === "running" || st.status === "pending")).toEqual([]);
    expect(bench.lines.join("")).not.toContain(SSH_KEYS.privateKey.split("\n")[1]!);
    const servers = await t.db.select().from(changePlans).where(eq(changePlans.status, "running"));
    expect(servers).toEqual([]);
    console.info(`charge : 6 plans sur 3 serveurs, 3 workers, ${seconds.toFixed(1)} s`);
  }, 600_000);
});
