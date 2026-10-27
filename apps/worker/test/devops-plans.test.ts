import {
  DEFAULT_ORG_ID,
  auditLog,
  changePlans,
  eq,
  orgs,
  planSteps,
  runs,
  serverCommands,
  servers,
  tasks,
  users,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { expandPlan, parsePlaybooks, type ChangePlan } from "@jules/devops";
import { FakeGitHub } from "@jules/forge/testing";
import { HostKeyMismatchError } from "@jules/ssh";
import { startTestSshServer } from "@jules/ssh/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverExec } from "../src/broker/server-tools.js";
import { applyCommand } from "../src/conversation.js";
import { PlanService } from "../src/devops/plans.js";
import type { ServerRow } from "../src/devops/servers.js";
import { SSH_KEYS, devopsBench, type DevopsBench } from "./devops-harness.js";
import { testDeps } from "./harness.js";

// DoD M7 : plans exacts, verrou par serveur, clé d'hôte épinglée, aucune clé dans les journaux.

let t: TestDatabase;
let bench: DevopsBench;
let staging: { server: ServerRow; host: Awaited<ReturnType<typeof startTestSshServer>> };
let repoId: string;
let agentRun: { taskId: string; runId: string };

beforeAll(async () => {
  t = await startTestDatabase();
  bench = devopsBench(t.db);
  repoId = (await bench.repo()).id;
  staging = await bench.addServer({
    name: "web-staging",
    environment: "staging",
    level: "D1",
    repoId,
  });
  // Une exécution de l'agent DevOps : les appels d'outils lui sont rattachés.
  const [task] = await t.db
    .insert(tasks)
    .values({
      orgId: DEFAULT_ORG_ID,
      repoId,
      agent: "devops",
      issueNumber: 7000,
      title: "diag",
      request: "diag",
      state: "diagnosing",
    })
    .returning();
  const [run] = await t.db
    .insert(runs)
    .values({
      orgId: DEFAULT_ORG_ID,
      taskId: task!.id,
      role: "devops",
      model: "claude-opus-5-5",
      promptVersion: "devops/v1",
      tokenHash: crypto.randomUUID(),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      budgetUsd: "1",
    })
    .returning();
  agentRun = { taskId: task!.id, runId: run!.id };
}, 600_000);
afterAll(async () => {
  await bench.stop();
  await t.stop();
});

const PLAYBOOKS = (() => {
  const parsed = parsePlaybooks(`
playbooks:
  release:
    steps:
      - run: echo v2 > /tmp/release
    verify:
      - run: grep -q v3 /tmp/release
    rollback:
      - run: echo v1 > /tmp/release
`);
  if (!parsed.ok) throw new Error(parsed.errors.join());
  return parsed.value;
})();

async function submitPlan(
  server: ServerRow,
  commands: string[],
  approvalRequired = false,
  taskId?: string,
) {
  const plan: ChangePlan = {
    goal: "test",
    server: server.name,
    environment: server.environment,
    actions: commands.map((command) => ({ kind: "command", command, reason: "test" })),
    impact: "aucun",
    verify: ["true"],
    rollback: ["true"],
  };
  const expanded = expandPlan(plan, {
    serverEnvironment: server.environment,
    playbooks: PLAYBOOKS,
  });
  if (!expanded.ok) throw new Error(expanded.problems.join());
  return t.db.transaction((tx) =>
    bench.plans.submit(tx, {
      server,
      plan,
      steps: expanded.steps,
      approvalRequired,
      ...(taskId ? { taskId } : {}),
    }),
  );
}

const ctx = (stopped = false) => ({
  orgId: DEFAULT_ORG_ID,
  ...agentRun,
  stopped,
  devops: { servers: bench.servers, plans: bench.plans, playbooks: PLAYBOOKS },
});

describe("plans de changement (WORKFLOW.md §12.1)", () => {
  it("exécute un plan approuvé, étape par étape, avec un journal avant et après chaque étape", async () => {
    const plan = await submitPlan(staging.server, ["echo bonjour > /tmp/hello"]);
    expect(await bench.plans.drain()).toBeGreaterThanOrEqual(1);
    const [done] = await t.db.select().from(changePlans).where(eq(changePlans.id, plan.id));
    const steps = await t.db.select().from(planSteps).where(eq(planSteps.planId, plan.id));
    expect(done?.status).toBe("succeeded");
    expect(steps.map((s) => [s.phase, s.status])).toEqual([
      ["action", "done"],
      ["verify", "done"],
      ["rollback", "skipped"],
    ]);
    expect(steps.every((s) => s.status === "skipped" || (s.startedAt && s.endedAt))).toBe(true);
    expect(await staging.host.exec("cat /tmp/hello")).toContain("bonjour");
  });

  it("refuse une action absente du plan approuvé et demande un nouveau plan", async () => {
    await submitPlan(staging.server, ["touch /tmp/prevu"]);
    await bench.plans.drain();
    const result = await t.db.transaction((tx) =>
      serverExec(tx, ctx(), { server: "web-staging", command: "touch /tmp/hors-plan" }),
    );
    expect(result.status).toBe(403);
    expect(result.text).toContain("submit_change_plan");
    expect(result.text).toContain("actions exactes");
    expect(await staging.host.exec("test -e /tmp/hors-plan && echo oui || echo non")).toContain(
      "non",
    );
    const [refused] = await t.db
      .select()
      .from(serverCommands)
      .where(eq(serverCommands.command, "touch /tmp/hors-plan"));
    expect(refused).toMatchObject({ decision: "require_approval", exitCode: null });
  });

  it("n'exécute pas un plan modifié après son approbation", async () => {
    const plan = await submitPlan(staging.server, ["touch /tmp/approuve"]);
    await t.db
      .update(changePlans)
      .set({ steps: [{ phase: "action", command: "touch /tmp/pirate" }] })
      .where(eq(changePlans.id, plan.id));
    await bench.plans.drain();
    const [row] = await t.db.select().from(changePlans).where(eq(changePlans.id, plan.id));
    expect(row).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("modifié"),
    });
    expect(await staging.host.exec("ls /tmp")).not.toMatch(/pirate|approuve/);
  });

  it("exécute deux plans lancés en même temps sur le même serveur l'un après l'autre", async () => {
    const first = await submitPlan(staging.server, ["sleep 2"]);
    const second = await submitPlan(staging.server, ["sleep 2"]);
    // Deux workers qui se disputent le serveur : le verrou les fait passer un par un.
    const other = new PlanService({ db: t.db, servers: bench.servers, log: bench.log });
    for (let i = 0; i < 20; i++) {
      await Promise.all([bench.plans.drain(), other.drain()]);
      const rows = await t.db
        .select()
        .from(changePlans)
        .where(eq(changePlans.serverId, staging.server.id));
      if (
        rows
          .filter((r) => [first.id, second.id].includes(r.id))
          .every((r) => r.status === "succeeded")
      ) {
        break;
      }
    }
    const [a, b] = (
      await Promise.all(
        [first.id, second.id].map((id) =>
          t.db.select().from(changePlans).where(eq(changePlans.id, id)),
        ),
      )
    ).map(([row]) => row!);
    expect([a!.status, b!.status]).toEqual(["succeeded", "succeeded"]);
    const [earlier, later] = [a!, b!].sort(
      (x, y) => x.startedAt!.getTime() - y.startedAt!.getTime(),
    );
    expect(later!.startedAt!.getTime()).toBeGreaterThanOrEqual(earlier!.endedAt!.getTime());
  });

  it("revient en arrière automatiquement quand la vérification d'un playbook échoue", async () => {
    const plan: ChangePlan = {
      goal: "release",
      server: staging.server.name,
      environment: "staging",
      actions: [{ kind: "playbook", name: "release", params: {} }],
      impact: "aucun",
      verify: ["true"],
      rollback: ["true"],
    };
    const expanded = expandPlan(plan, { serverEnvironment: "staging", playbooks: PLAYBOOKS });
    if (!expanded.ok) throw new Error(expanded.problems.join());
    const row = await t.db.transaction((tx) =>
      bench.plans.submit(tx, {
        server: staging.server,
        plan,
        steps: expanded.steps,
        approvalRequired: false,
      }),
    );
    await bench.plans.drain();
    const [done] = await t.db.select().from(changePlans).where(eq(changePlans.id, row.id));
    expect(done?.status).toBe("rolled_back");
    expect(await staging.host.exec("cat /tmp/release")).toContain("v1");
  });

  it("expire un plan non approuvé après son délai", async () => {
    const plan = await submitPlan(staging.server, ["touch /tmp/jamais"], true);
    await t.db
      .update(changePlans)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(changePlans.id, plan.id));
    expect(await bench.plans.expire()).toBe(1);
    const [row] = await t.db.select().from(changePlans).where(eq(changePlans.id, plan.id));
    expect(row?.status).toBe("expired");
  });
});

describe("approbation de la production (ARCHITECTURE.md §9 et §12)", () => {
  it("refuse l'approbation depuis GitHub tant qu'un admin ne l'a pas activée, puis l'accepte", async () => {
    const prod = await bench.addServer({
      name: "web-prod",
      environment: "production",
      level: "D3",
      repoId,
    });
    const [task] = await t.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId,
        agent: "devops",
        issueNumber: 7001,
        title: "Redémarrer l'app en production",
        request: "@jules devops redémarre l'app",
        state: "awaiting_plan_approval",
      })
      .returning();
    const plan = await submitPlan(prod.server, ["touch /tmp/prod-ok"], true, task!.id);
    const deps = {
      ...testDeps(t.db, new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" })),
      plans: bench.plans,
    };
    const [approver] = await t.db
      .insert(users)
      .values({ orgId: DEFAULT_ORG_ID, login: "maya", kind: "human" })
      .returning();
    const approve = (source: "github" | "web", stepUp: boolean) =>
      t.db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(tasks).where(eq(tasks.id, task!.id));
        return applyCommand(
          tx,
          deps,
          fresh!,
          { name: "approve" },
          { type: "user", id: approver!.id },
          {
            source,
            role: "maintain",
            stepUp,
          },
        );
      });

    expect(await approve("github", false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("depuis GitHub désactivée"),
    });
    expect(await approve("web", false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("passkey"),
    });
    await t.db
      .update(orgs)
      .set({ githubProductionApproval: true })
      .where(eq(orgs.id, DEFAULT_ORG_ID));
    try {
      expect(await approve("github", false)).toMatchObject({ ok: true });
    } finally {
      await t.db
        .update(orgs)
        .set({ githubProductionApproval: false })
        .where(eq(orgs.id, DEFAULT_ORG_ID));
    }
    const [approved] = await t.db.select().from(changePlans).where(eq(changePlans.id, plan.id));
    expect(approved).toMatchObject({ status: "approved", approvalSource: "github" });
    const [executing] = await t.db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(executing?.state).toBe("executing");
    await bench.plans.drain();
    const [done] = await t.db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(done?.state).toBe("done");
  });
});

describe("clé d'hôte épinglée et secrets (DoD M7)", () => {
  it("bloque le serveur quand sa clé d'hôte change", async () => {
    // Même nom, même adresse logique : un autre serveur (nouvelle clé d'hôte) répond à sa place.
    const { server } = await bench.addServer({
      name: "web-qa",
      environment: "staging",
      level: "D3",
      repoId,
    });
    const impostor = await startTestSshServer(SSH_KEYS.publicKey);
    try {
      await t.db
        .update(servers)
        .set({ host: impostor.host, port: impostor.port })
        .where(eq(servers.id, server.id));
      const [moved] = await t.db.select().from(servers).where(eq(servers.id, server.id));
      await expect(
        bench.servers.execute(moved!, "uptime", {
          source: "agent",
          commandClass: "read",
          decision: { effect: "allow", ruleId: "server.read", reason: "lecture" },
        }),
      ).rejects.toBeInstanceOf(HostKeyMismatchError);
      const [blocked] = await t.db.select().from(servers).where(eq(servers.id, server.id));
      expect(blocked?.hostKeyStatus).toBe("changed");
      const refused = await t.db.transaction((tx) =>
        serverExec(tx, ctx(), { server: "web-qa", command: "uptime" }),
      );
      expect(refused).toMatchObject({ status: 403, text: expect.stringContaining("clé d'hôte") });
      const audit = await t.db.select().from(auditLog).where(eq(auditLog.targetId, server.id));
      expect(audit.map((a) => a.action)).toContain("server.host_key_changed");
    } finally {
      await impostor.stop();
    }
  });

  it("ne laisse la clé SSH ni dans les sorties, ni dans les journaux, ni dans l'audit", async () => {
    // Le serveur affiche lui-même la clé privée : la sortie gardée doit être masquée.
    await staging.host.exec(`printf '%s' '${SSH_KEYS.privateKey}' > /tmp/fuite`);
    const result = await t.db.transaction((tx) =>
      serverExec(tx, ctx(), { server: "web-staging", command: "cat /tmp/fuite" }),
    );
    const text = await result.after!();
    const secretLines = SSH_KEYS.privateKey
      .split("\n")
      .filter((l) => l.length > 20 && !l.startsWith("-----"));
    expect(secretLines.length).toBeGreaterThan(0);
    const stored = await t.db.select({ output: serverCommands.output }).from(serverCommands);
    const audit = await t.db.select({ data: auditLog.data }).from(auditLog);
    const haystacks = [text, bench.lines.join("\n"), JSON.stringify(stored), JSON.stringify(audit)];
    for (const haystack of haystacks) {
      for (const line of secretLines) {
        expect(haystack).not.toContain(line);
      }
    }
    expect(text).toContain("[masqué]");
  });
});
