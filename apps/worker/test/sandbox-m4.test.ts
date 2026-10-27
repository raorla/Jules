import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORG_ID, artifacts, eq, runs, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drainOutbox } from "../src/outbox.js";
import { startFakeModel, type FakeModel, type Step } from "./fake-model.js";
import { seedTask, testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { sandboxSetup } from "./sandbox-harness.js";

// Definition of Done de M4 (ROADMAP.md) : review IA par un autre modèle, en contexte vierge,
// publiée en COMMENT avec commentaires en ligne, check run « Jules / review », matrice de traçabilité.

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

const SPEC = {
  problem: "Pas d'endpoint de santé.",
  acceptanceCriteria: [
    { id: "AC-1", given: "le service démarré", when: "GET /healthz", then: "200" },
    { id: "AC-2", given: "la base coupée", when: "GET /healthz", then: "503" },
  ],
  outOfScope: [],
  assumptions: [],
};
const ref = { installationId: 4242, owner: "acme", repo: "sandbox" };

/** Tâche en review : une branche poussée, une PR ouverte, une spec, des gates vertes. */
async function inReview(s: ReturnType<typeof sandboxSetup>, risk: "low" | "high" = "low") {
  const { task } = await seedTask(t.db);
  const seed = mkdtempSync(join(tmpdir(), "jules-m4-"));
  execFileSync("git", ["clone", "-q", s.remote, seed]);
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
      .toString()
      .trim();
  const base = g("rev-parse", "HEAD");
  const branch = `jules/${task.issueNumber}-healthz`;
  g("checkout", "-q", "-b", branch);
  writeFileSync(join(seed, "health.js"), "export const health = () => ({ ok: true });\n");
  g("add", "-A");
  g("commit", "-q", "-m", `feat: health\n\nJules-Task: ${task.id}`);
  g("push", "-q", "origin", branch);
  const head = g("rev-parse", "HEAD");
  const pr = await s.github.createPullRequest(ref, {
    head: branch,
    base: "main",
    draft: true,
    title: "feat: health",
    body: "",
  });
  await t.db
    .insert(artifacts)
    .values({ orgId: DEFAULT_ORG_ID, taskId: task.id, kind: "spec", version: 1, content: SPEC });
  await t.db
    .update(tasks)
    .set({
      state: "reviewing",
      risk,
      baseSha: base,
      headSha: head,
      branch,
      prNumber: pr.number,
      prUrl: pr.url,
    })
    .where(eq(tasks.id, task.id));
  return { task, branch, head, pr };
}

const review = (input: Record<string, unknown>): Step[] => [
  { tool: "mcp__jules__submit_review", input },
  { text: "Terminé." },
];

describe("M4 : review IA", () => {
  it("renvoie en développement une PR dont un critère n'est pas implémenté", async () => {
    model = await startFakeModel({
      review: review({
        verdict: "request_changes",
        summary: "AC-2 n'est pas implémenté.",
        acVerdicts: [
          { ac: "AC-1", status: "met", note: "testé" },
          { ac: "AC-2", status: "missing", note: "aucune gestion de la base coupée" },
        ],
        findings: [
          {
            severity: "major",
            file: "health.js",
            line: 1,
            ac: "AC-2",
            comment: "retourne toujours ok",
          },
        ],
      }),
    });
    const s = sandboxSetup(t.db, model);
    const { task, pr } = await inReview(s);

    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();
    await drainOutbox(testDeps(t.db, s.github));

    const [after] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after).toMatchObject({ state: "building", reviewRounds: 1 });
    expect(after?.lastError).toContain("AC-2 non implémenté");
    // Un autre modèle que le développeur, en contexte vierge : il a reçu le diff, pas une transcription.
    const [run] = await t.db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run).toMatchObject({ role: "reviewer", model: "claude-sonnet-5-5" });
    const reviewerRequest = model.requests.find((r) =>
      JSON.stringify(r.body).includes("mcp__jules__submit_review"),
    );
    expect(JSON.stringify(reviewerRequest?.body)).toContain("# Diff de la PR");
    expect(JSON.stringify(reviewerRequest?.body)).not.toContain("en phase 4 (développement)");
    // Review GitHub de type COMMENT, avec le commentaire en ligne, et check run en échec.
    expect(s.github.reviews).toHaveLength(1);
    expect(s.github.reviews[0]).toMatchObject({
      number: pr.number,
      comments: [{ path: "health.js", line: 1, body: "**major** : retourne toujours ok" }],
    });
    expect(
      s.github.checkRuns.get(after!.headSha!)?.find((c) => c.name === "Jules / review")?.conclusion,
    ).toBe("failure");
    const body = s.github.pullRequests.find((p) => p.number === pr.number)?.body ?? "";
    expect(body).toContain(`Closes #${task.issueNumber}`);
    expect(body).toMatch(/\| AC-2 \| .* \| ❌ \|/);
  });

  it("une review favorable passe la PR en ready en L2", async () => {
    model = await startFakeModel({
      review: review({
        verdict: "approve",
        summary: "Rien à redire.",
        acVerdicts: [
          { ac: "AC-1", status: "met" },
          { ac: "AC-2", status: "met" },
        ],
      }),
    });
    const s = sandboxSetup(t.db, model);
    const { task, pr } = await inReview(s);

    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();
    await drainOutbox(testDeps(t.db, s.github));

    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe(
      "awaiting_human_review",
    );
    expect(s.github.pullRequests.find((p) => p.number === pr.number)).toMatchObject({
      draft: false,
      ready: true,
    });
    const checks =
      s.github.checkRuns.get(
        (await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.headSha!,
      ) ?? [];
    expect(checks.find((c) => c.name === "Jules / review")?.conclusion).toBe("success");
    expect(s.github.pullRequests.find((p) => p.number === pr.number)?.body).toMatch(
      /\| AC-1 \| .* \| ✅ \|/,
    );
  });

  it("une PR à risque high est relue par le reviewer de sécurité", async () => {
    model = await startFakeModel({
      review: review({
        verdict: "escalate",
        summary: "À trancher.",
        acVerdicts: [
          { ac: "AC-1", status: "met" },
          { ac: "AC-2", status: "met" },
        ],
      }),
    });
    const s = sandboxSetup(t.db, model);
    const { task } = await inReview(s, "high");

    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    const [run] = await t.db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run).toMatchObject({ role: "security_reviewer", model: "claude-opus-5-5" });
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe(
      "awaiting_human_review",
    );
  });
});
