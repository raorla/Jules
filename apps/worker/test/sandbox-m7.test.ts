import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ORG_ID,
  artifacts,
  auditLog,
  changePlans,
  eq,
  runs,
  tasks,
  toolCalls,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { SSH_KEYS, devopsBench, type DevopsBench } from "./devops-harness.js";
import { startFakeModel, type FakeModel } from "./fake-model.js";
import { issueComment } from "./fixtures.js";
import { storeEvent, testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { sandboxSetup } from "./sandbox-harness.js";

// DoD M7, de bout en bout avec le vrai sandbox : `@jules devops` dans une issue, diagnostic par
// l'agent (vrai binaire Claude Code, faux fournisseur de modèle), plan approuvé par `/jules approve`,
// exécution par le worker sur un vrai serveur SSH. Aucune clé SSH n'entre dans le sandbox.

let t: TestDatabase;
let model: FakeModel;
let bench: DevopsBench;

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
  bench = devopsBench(t.db);
}, 900_000);
afterAll(async () => {
  await model.close();
  await bench.stop();
  await t.stop();
});

/** Tous les fichiers d'un dossier, pour y chercher une fuite. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return [];
    return stat.isDirectory() ? filesUnder(path) : stat.size < 5_000_000 ? [path] : [];
  });
}

describe("agent DevOps de bout en bout (M7)", () => {
  it("diagnostique, propose un plan, l'exécute après approbation, sans jamais voir la clé", async () => {
    model = await startFakeModel({
      devops: [
        {
          tool: "mcp__jules__server_exec",
          input: {
            server: "web-staging",
            command: "cat /etc/os-release",
            reason: "voir le système",
          },
        },
        {
          tool: "mcp__jules__submit_change_plan",
          input: {
            goal: "Redémarrer l'application",
            server: "web-staging",
            environment: "staging",
            actions: [
              { kind: "command", command: "touch /tmp/redemarre", reason: "redémarrage simulé" },
            ],
            impact: "quelques secondes",
            verify: ["test -e /tmp/redemarre"],
            rollback: ["rm -f /tmp/redemarre"],
          },
        },
        { text: "Plan soumis." },
      ],
    });
    const setup = sandboxSetup(
      t.db,
      model,
      {},
      { devops: { servers: bench.servers, plans: bench.plans } },
    );
    setup.github.setRole("alice", "write");
    const repo = await bench.repo();
    const { host } = await bench.addServer({
      name: "web-staging",
      environment: "staging",
      level: "D1",
      repoId: repo.id,
    });
    const deps = { ...testDeps(t.db, setup.github), plans: bench.plans };

    // 1. La demande, depuis GitHub.
    await storeEvent(
      t.db,
      "issue_comment",
      issueComment({ body: "@jules devops redémarre l'app", issueNumber: 71 }),
    );
    await drainEvents(deps);
    const [task] = await t.db.select().from(tasks).where(eq(tasks.issueNumber, 71));
    expect(task).toMatchObject({ agent: "devops", state: "received" });

    // 2. Diagnostic et plan, par l'agent dans le sandbox.
    await setup.orchestrator.settle();
    const [waiting] = await t.db.select().from(tasks).where(eq(tasks.id, task!.id));
    const runRows = await t.db.select().from(runs).where(eq(runs.taskId, task!.id));
    expect({
      state: waiting?.state,
      error: waiting?.lastError,
      runs: runRows.map((r) => r.role),
    }).toEqual({ state: "awaiting_plan_approval", error: null, runs: ["devops"] });
    const calls = await t.db
      .select({ capability: toolCalls.capability, output: toolCalls.output })
      .from(toolCalls)
      .innerJoin(runs, eq(runs.id, toolCalls.runId))
      .where(eq(runs.taskId, task!.id));
    expect(calls.find((c) => c.capability === "server_exec")?.output).toMatch(
      /^ok: web-staging · code 0[\s\S]*Alpine/,
    );
    await drainOutbox(deps);
    const status = setup.github.comments.map((c) => c.body).join("\n");
    expect(status).toContain("Plan de changement");
    expect(status).toContain("`touch /tmp/redemarre`");
    expect(status).toContain("/jules approve");

    // 3. Approbation depuis GitHub (hors production), puis exécution par le worker.
    await storeEvent(
      t.db,
      "issue_comment",
      issueComment({ body: "/jules approve", issueNumber: 71 }),
    );
    await drainEvents(deps);
    const [plan] = await t.db.select().from(changePlans).where(eq(changePlans.taskId, task!.id));
    expect(plan).toMatchObject({ status: "approved", approvalSource: "github" });
    await bench.plans.drain();
    const [done] = await t.db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(done?.state).toBe("done");
    expect(await host.exec("test -e /tmp/redemarre && echo oui")).toContain("oui");
    const [report] = await t.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, task!.id))
      .then((rows) => rows.filter((r) => r.kind === "plan_report"));
    expect(report?.content).toMatchObject({ outcome: "succeeded" });

    // 4. La clé SSH n'est nulle part : ni dans le sandbox, ni dans ses fichiers, ni dans les journaux.
    const secret = SSH_KEYS.privateKey
      .split("\n")
      .filter((l) => l.length > 20 && !l.startsWith("-----"));
    for (const spec of setup.driver.specs) {
      expect(Object.keys(spec.env ?? {})).toEqual(["JULES_RUN_TOKEN"]);
      expect(JSON.stringify(spec)).not.toContain(secret[0]);
    }
    const leaked = filesUnder(setup.runsDir).filter((file) => {
      const content = readFileSync(file, "latin1");
      return secret.some((line) => content.includes(line));
    });
    expect(leaked).toEqual([]);
    const audit = await t.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(eq(auditLog.orgId, DEFAULT_ORG_ID));
    for (const line of secret) {
      expect(JSON.stringify(audit)).not.toContain(line);
      expect(bench.lines.join("")).not.toContain(line);
    }
  });
});
