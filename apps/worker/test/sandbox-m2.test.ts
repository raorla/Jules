import {
  DEFAULT_ORG_ID,
  asc,
  auditLog,
  commands,
  eq,
  events,
  repos,
  runs,
  sql,
  tasks,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { startFakeModel, type FakeModel, type Step } from "./fake-model.js";
import { issueComment } from "./fixtures.js";
import { seedTask, testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { sandboxSetup } from "./sandbox-harness.js";

// Definition of Done de M2 (ROADMAP.md) : machine à états, phases 1 à 3 et gates humaines,
// avec le vrai sandbox et un faux fournisseur de modèle qui joue un scénario par rôle.

let t: TestDatabase;
let model: FakeModel | undefined;

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
}, 900_000);
afterAll(async () => {
  await t.stop();
});
afterEach(async () => {
  await model?.close();
  model = undefined;
});

const done: Step = { text: "Terminé." };
const triage = (input: Record<string, unknown>): Step[] => [
  { tool: "mcp__jules__submit_triage", input },
  done,
];
const SPEC: Step[] = [
  {
    tool: "mcp__jules__submit_spec",
    input: {
      problem: "Le service n'expose aucun endpoint de santé.",
      acceptanceCriteria: [
        {
          id: "AC-1",
          given: "le service démarré",
          when: "on appelle GET /healthz",
          then: "il répond 200",
        },
      ],
    },
  },
  done,
];
const DESIGN: Step[] = [
  {
    tool: "mcp__jules__submit_design",
    input: {
      approach: "Ajouter une route dédiée.",
      steps: ["Écrire le test", "Ajouter la route"],
      files: [{ path: "health.js", change: "add", why: "route de santé" }],
      testPlan: [{ ac: "AC-1", level: "unit", test: "health renvoie ok" }],
      rollback: "revert du commit",
    },
  },
  done,
];
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
    input: {
      summary: "Ajoute /healthz.",
      commitMessage: "feat(api): ajoute /healthz",
      acTests: [{ ac: "AC-1", tests: ["health.test.js"] }],
    },
  },
  done,
];

const ref = { installationId: 4242, owner: "acme", repo: "sandbox" };
const state = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0];
// Dans l'ordre des exécutions : sans tri, PostgreSQL rend les lignes dans un ordre quelconque.
const rolesRun = async (id: string) =>
  (
    await t.db
      .select({ role: runs.role })
      .from(runs)
      .where(eq(runs.taskId, id))
      .orderBy(asc(runs.createdAt), asc(runs.startedAt))
  ).map((r) => r.role);
const setAutonomy = (autonomy: "L0" | "L1" | "L2") =>
  t.db.update(repos).set({ autonomy }).where(eq(repos.githubRepoId, 99));

async function comment(issueNumber: number, login: string, body: string) {
  await t.db.insert(events).values({
    orgId: DEFAULT_ORG_ID,
    deliveryId: crypto.randomUUID(),
    event: "issue_comment",
    action: "created",
    githubInstallationId: 4242,
    payload: issueComment({ body, login, issueNumber }),
  });
}

describe("M2 : machine à états, phases 1 à 3, gates humaines", () => {
  it("une issue vague donne des questions, et aucun code", async () => {
    model = await startFakeModel({
      triage: triage({
        type: "bug",
        size: "S",
        estimatedRisk: "low",
        ready: false,
        questions: ["Sur quelle page voyez-vous l'erreur ?", "Quel navigateur ?"],
      }),
      build: BUILD,
    });
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db, {
      state: "received",
      issueNumber: 201,
      title: "Ça marche pas",
      request: "@jules ça marche pas",
    });
    await setAutonomy("L2");

    await s.orchestrator.settle();
    await drainOutbox(testDeps(t.db, s.github));

    expect(await state(task.id)).toMatchObject({
      state: "awaiting_info",
      questionRounds: 1,
      resumeState: "triaging",
    });
    expect(await rolesRun(task.id)).toEqual(["triager"]);
    const status = s.github.commentsOn(ref, 201).at(-1)?.body ?? "";
    expect(status).toContain("en attente de ta réponse");
    expect(status).toContain("1. Sur quelle page voyez-vous l'erreur ?");
    expect(s.github.pullRequests).toHaveLength(0);

    // Une réponse d'une personne autorisée relance le triage.
    await comment(201, "alice", "Sur /profil, avec Firefox.");
    await drainEvents(testDeps(t.db, s.github));
    expect((await state(task.id))?.state).toBe("triaging");
  });

  it("une feature medium publie sa spec, attend /jules approve et ignore celui d'une personne sans droit", async () => {
    model = await startFakeModel({
      triage: triage({
        type: "feature",
        size: "M",
        estimatedRisk: "medium",
        ready: true,
        likelyAreas: ["src/health.js"],
      }),
      spec: SPEC,
      design: DESIGN,
      build: BUILD,
    });
    const s = sandboxSetup(t.db, model);
    s.github.setRole("bob", "read");
    const { task } = await seedTask(t.db, { state: "received", issueNumber: 202 });
    await setAutonomy("L2");
    const deps = testDeps(t.db, s.github);

    await s.orchestrator.settle();
    await drainOutbox(deps);
    expect(await state(task.id)).toMatchObject({
      state: "awaiting_spec_approval",
      type: "feature",
      risk: "medium",
      autonomy: "L2",
    });
    const status =
      s.github.commentsOn(ref, 202).find((c) => c.body.includes("jules:status"))?.body ?? "";
    expect(status).toContain("**AC-1**");
    expect(status).toContain("/jules approve");

    await comment(202, "bob", "/jules approve");
    await drainEvents(deps);
    await drainOutbox(deps);
    expect((await state(task.id))?.state).toBe("awaiting_spec_approval");
    const [denied] = await t.db.select().from(commands).where(eq(commands.taskId, task.id));
    expect(denied).toMatchObject({ name: "approve", decision: "denied" });
    expect(s.github.commentsOn(ref, 202).some((c) => c.body.includes("commande refusée"))).toBe(
      true,
    );

    await comment(202, "alice", "Parfait.\n/jules approve");
    await drainEvents(deps);
    expect((await state(task.id))?.state).toBe("designing");

    // Une seconde approbation ne compte pas : il n'y a plus rien à valider.
    await comment(202, "alice", "/jules approve");
    await drainEvents(deps);

    await s.orchestrator.settle();
    await drainOutbox(deps);
    expect(await rolesRun(task.id)).toEqual(["triager", "specifier", "architect", "developer"]);
    // Les gates (M3) attendent que le push soit fait : ici, l'outbox ne tourne qu'après.
    expect((await state(task.id))?.state).toBe("verifying");
    expect(s.github.pullRequests).toHaveLength(1);
    const decisions = await t.db
      .select({ decision: commands.decision })
      .from(commands)
      .where(eq(commands.taskId, task.id));
    expect(decisions.map((d) => d.decision)).toEqual(["denied", "applied", "rejected"]);
    const transitions = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_log where target_id = ${task.id} and action = 'task.transition'`,
    );
    expect(transitions.rows[0]?.n).toBeGreaterThanOrEqual(5);
    expect(auditLog).toBeDefined();
  });

  it("une correction de coquille (low) suit la voie rapide jusqu'à la PR, sans attente", async () => {
    model = await startFakeModel({
      triage: triage({
        type: "docs",
        size: "S",
        estimatedRisk: "low",
        ready: true,
        likelyAreas: ["README.md"],
      }),
      spec: SPEC,
      design: DESIGN,
      build: BUILD,
    });
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db, {
      state: "received",
      issueNumber: 203,
      title: "Corriger une coquille",
    });
    await setAutonomy("L2");

    await s.orchestrator.settle();
    await drainOutbox(testDeps(t.db, s.github));

    expect(await state(task.id)).toMatchObject({ state: "verifying", risk: "low" });
    expect(await rolesRun(task.id)).toEqual(["triager", "specifier", "architect", "developer"]);
    expect(s.github.pullRequests).toHaveLength(1);
  });

  it("en L0, la tâche s'arrête après la conception", async () => {
    model = await startFakeModel({
      triage: triage({ type: "feature", size: "S", estimatedRisk: "medium", ready: true }),
      spec: SPEC,
      design: DESIGN,
      build: BUILD,
    });
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db, { state: "received", issueNumber: 204 });
    await setAutonomy("L0");

    await s.orchestrator.settle();
    await drainOutbox(testDeps(t.db, s.github));

    expect(await state(task.id)).toMatchObject({ state: "done", autonomy: "L0" });
    expect(await rolesRun(task.id)).toEqual(["triager", "specifier", "architect"]);
    expect(s.github.pullRequests).toHaveLength(0);
    expect(s.github.commentsOn(ref, 204).at(-1)?.body).toContain("Mode conseil (L0)");
  });
});
