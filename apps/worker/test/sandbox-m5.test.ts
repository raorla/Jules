import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORG_ID, artifacts, eq, events, lessons, repos, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compareEvals, runEvals } from "../src/evals.js";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { startFakeModel, type FakeModel, type Scripts, type Step } from "./fake-model.js";
import { issueComment } from "./fixtures.js";
import { seedTask, testDeps } from "./harness.js";
import { TEST_IMAGES, ensureTestImages } from "./images.js";
import { ROOT, sandboxSetup } from "./sandbox-harness.js";

// Definition of Done de M5 (ROADMAP.md) : un changement de prompt est évalué avant déploiement,
// et refusé s'il fait régresser le score. Plus le learner et ses leçons validées par un humain.

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
const MUL_TEST =
  'import test from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/math.js";\n\ntest("mul", () => {\n  assert.equal(mul(2, 3), 6);\n});\n';
const MATH =
  "export function sum(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n";

/** Le bon scénario ; avec le marqueur dans le prompt du développeur, il oublie les tests. */
function scripts(body: Record<string, unknown>): Scripts {
  const regressed = JSON.stringify(body.system ?? "").includes("MARQUEUR-EVAL-REGRESSION");
  return {
    triage: [
      {
        tool: "mcp__jules__submit_triage",
        input: {
          type: "feature",
          size: "S",
          estimatedRisk: "low",
          ready: true,
          likelyAreas: ["src/math.js"],
        },
      },
      done,
    ],
    spec: [
      {
        tool: "mcp__jules__submit_spec",
        input: {
          problem: "Pas de multiplication.",
          acceptanceCriteria: [
            {
              id: "AC-1",
              given: "deux nombres",
              when: "on appelle mul",
              then: "on obtient leur produit",
            },
          ],
        },
      },
      done,
    ],
    design: [
      {
        tool: "mcp__jules__submit_design",
        input: {
          approach: "Fonction pure.",
          steps: ["test", "code"],
          files: [{ path: "src/math.js", change: "modify", why: "mul" }],
          testPlan: [{ ac: "AC-1", level: "unit", test: "mul(2, 3) = 6" }],
          rollback: "revert",
        },
      },
      done,
    ],
    build: regressed
      ? [
          { tool: "Write", input: { file_path: "/workspace/src/math.js", content: MATH } },
          {
            tool: "mcp__jules__submit_build",
            input: { summary: "mul", commitMessage: "feat: ajoute mul" },
          },
          done,
        ]
      : [
          { tool: "Write", input: { file_path: "/workspace/test/mul.test.js", content: MUL_TEST } },
          { tool: "Write", input: { file_path: "/workspace/src/math.js", content: MATH } },
          {
            tool: "mcp__jules__submit_build",
            input: {
              summary: "mul",
              commitMessage: "feat: ajoute mul",
              acTests: [{ ac: "AC-1", tests: ["test/mul.test.js › mul"] }],
            },
          },
          done,
        ],
    review: [
      {
        tool: "mcp__jules__submit_review",
        input: { verdict: "approve", summary: "ok", acVerdicts: [{ ac: "AC-1", status: "met" }] },
      },
      done,
    ],
  };
}

describe("M5 : evals", () => {
  it("refuse un changement de prompt qui fait régresser le score", async () => {
    model = await startFakeModel(scripts);
    const suite = mkdtempSync(join(tmpdir(), "jules-suite-"));
    cpSync(join(ROOT, "evals", "fixtures"), join(suite, "fixtures"), { recursive: true });
    cpSync(join(ROOT, "evals", "tasks", "mul"), join(suite, "tasks", "mul"), { recursive: true });
    const candidate = mkdtempSync(join(tmpdir(), "jules-prompts-"));
    cpSync(join(ROOT, "prompts"), candidate, { recursive: true });
    writeFileSync(
      join(candidate, "developer", "v1.md"),
      `${readFileSync(join(candidate, "developer", "v1.md"), "utf8")}\nMARQUEUR-EVAL-REGRESSION\n`,
    );
    const s = sandboxSetup(t.db, model);
    const config = {
      promptsDir: join(ROOT, "prompts"),
      sandboxImage: TEST_IMAGES.sandbox,
      egressAllow: ["registry.npmjs.org"],
      language: "fr" as const,
      model: { upstream: model.url, apiKey: "sk-ant-eval-0123456789abcdef0123" },
      developer: {
        model: "claude-opus-5-5",
        effort: "high" as const,
        maxTurns: 20,
        budgetUsd: 5,
        timeoutMs: 180_000,
      },
      maxConcurrentRuns: 1,
      providerRetryBaseMs: 300,
      maxAttempts: 3,
    };
    const run = (label: string, promptsDir: string) =>
      runEvals({
        db: t.db,
        driver: s.driver,
        log: pino({ level: "silent" }),
        suiteDir: suite,
        label,
        config: { ...config, promptsDir },
      });

    const baseline = await run("base", join(ROOT, "prompts"));
    const regressed = await run("candidat", candidate);

    expect(baseline.tasks[0]).toMatchObject({ id: "mul", state: "awaiting_human_review" });
    expect(baseline.total).toBeGreaterThan(80);
    expect(regressed.total).toBeLessThan(baseline.total);
    const verdict = compareEvals(baseline, regressed);
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions[0]).toMatch(/^mul : /);
    expect(compareEvals(baseline, baseline).ok).toBe(true);
  }, 600_000);
});

describe("M5 : learner et leçons", () => {
  it("propose des leçons, un humain les valide, elles servent aux tâches suivantes", async () => {
    model = await startFakeModel((body) => ({
      ...scripts(body),
      triage: [
        {
          tool: "mcp__jules__submit_triage",
          input: { type: "bug", size: "S", estimatedRisk: "low", ready: false, questions: ["?"] },
        },
        done,
      ],
    }));
    // Le learner est reconnu à son outil propose_lessons : on lui ajoute un scénario.
    const learner: Step[] = [
      {
        tool: "mcp__jules__propose_lessons",
        input: {
          lessons: [
            {
              text: "Les fonctions de src/math.js convertissent leurs arguments avec Number().",
              source: "review humaine de la PR",
            },
          ],
        },
      },
      done,
    ];
    const original = model;
    model = await startFakeModel((body) => ({ ...scripts(body), learn: learner }));
    await original.close();
    const s = sandboxSetup(t.db, model);
    s.github.setRole("mona", "maintain");
    const { task } = await seedTask(t.db, { issueNumber: 600 });
    await t.db
      .update(tasks)
      .set({ state: "learning", prNumber: 6001, baseSha: null, branch: null })
      .where(eq(tasks.id, task.id));
    await t.db.insert(artifacts).values({
      orgId: DEFAULT_ORG_ID,
      taskId: task.id,
      kind: "pr_closed",
      version: 1,
      content: { merged: true },
    });

    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();
    await drainOutbox(testDeps(t.db, s.github));

    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe("done");
    const [lesson] = await t.db.select().from(lessons).where(eq(lessons.taskId, task.id));
    expect(lesson).toMatchObject({ status: "proposed" });
    const comment =
      s.github.commentsOn({ installationId: 4242, owner: "acme", repo: "sandbox" }, 6001).at(-1)
        ?.body ?? "";
    expect(comment).toContain(lesson!.id.slice(0, 8));

    await t.db.insert(events).values({
      orgId: DEFAULT_ORG_ID,
      deliveryId: crypto.randomUUID(),
      event: "issue_comment",
      action: "created",
      githubInstallationId: 4242,
      payload: issueComment({
        body: `/jules lesson approve ${lesson!.id.slice(0, 8)}`,
        login: "mona",
        issueNumber: 6001,
        onPullRequest: true,
      }),
    });
    await drainEvents(testDeps(t.db, s.github));
    expect((await t.db.select().from(lessons).where(eq(lessons.id, lesson!.id)))[0]?.status).toBe(
      "approved",
    );

    // Tâche suivante du même repo : la leçon validée est dans le contexte de l'agent.
    await t.db.update(repos).set({ autonomy: "L2" }).where(eq(repos.githubRepoId, 99));
    const next = await seedTask(t.db, { state: "received", issueNumber: 601 });
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();
    const triagerRequest = model.requests.find((r) => {
      const body = JSON.stringify(r.body);
      return body.includes("mcp__jules__submit_triage") && body.includes("issue #601");
    });
    expect(next.task.id).toBeTruthy();
    expect(JSON.stringify(triagerRequest?.body)).toContain(
      "Leçons de ce repo (validées par un humain)",
    );
    expect(JSON.stringify(triagerRequest?.body)).toContain(
      "Les fonctions de src/math.js convertissent leurs arguments",
    );
  }, 300_000);
});
