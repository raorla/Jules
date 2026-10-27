import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "@jules/artifacts";
import {
  DEFAULT_ORG_ID,
  and,
  artifacts,
  desc,
  eq,
  installations,
  repos,
  tasks,
  type Db,
} from "@jules/db";
import { FakeGitHub } from "@jules/forge/testing";
import type { GateReport } from "@jules/gates";
import type { SandboxDriver } from "@jules/sandbox";
import type { Logger } from "pino";
import { z } from "zod";
import { Masker } from "./broker/masking.js";
import { applyTransition } from "./transitions.js";
import { drainOutbox } from "./outbox.js";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator.js";

// Suite d'evals (WORKFLOW.md §11) : chaque tâche de référence est jouée de bout en bout, sandbox
// compris, sur un dépôt local. Un changement de prompt, de modèle ou de règle ne part que si le score
// ne régresse pas. Les gates humaines sont approuvées automatiquement : on mesure l'agent, pas l'attente.

export const evalTaskSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  /** Dossier du dépôt de départ, relatif à la suite (copié comme premier commit de `main`). */
  fixture: z.string(),
  type: z.enum(["bug", "feature", "refactor", "chore", "docs", "test", "security"]),
  issue: z.object({ title: z.string(), body: z.string() }),
});
export type EvalTask = z.infer<typeof evalTaskSchema>;

export type TaskScore = {
  id: string;
  score: number;
  state: string;
  details: { gates: number; criteria: number; review: number; cost: number; costUsd: number };
};
export type EvalResult = { label: string; total: number; tasks: TaskScore[] };

export function loadSuite(dir: string): EvalTask[] {
  return readdirSync(join(dir, "tasks"))
    .filter((name) => existsSync(join(dir, "tasks", name, "task.json")))
    .sort()
    .map((name) =>
      evalTaskSchema.parse(JSON.parse(readFileSync(join(dir, "tasks", name, "task.json"), "utf8"))),
    );
}

/** Score sur 100 : gates 40, critères 30, verdict du reviewer 15, coût 15. */
export function scoreTask(input: {
  state: string;
  gates?: GateReport | undefined;
  review?: Review | undefined;
  acCount: number;
  costUsd: number;
  budgetUsd: number;
}): TaskScore["details"] & { score: number } {
  const results = input.gates?.results.filter((r) => r.status !== "skip") ?? [];
  const gates =
    results.length === 0
      ? 0
      : (40 * results.filter((r) => r.status !== "fail").length) / results.length;
  const met = input.review?.acVerdicts.filter((a) => a.status === "met").length ?? 0;
  const criteria = input.acCount === 0 ? 0 : (30 * Math.min(met, input.acCount)) / input.acCount;
  const review =
    input.review?.verdict === "approve" ? 15 : input.review?.verdict === "escalate" ? 7 : 0;
  const cost = 15 * Math.max(0, Math.min(1, 1 - input.costUsd / input.budgetUsd));
  const delivered = ["awaiting_human_review", "reviewing", "learning", "done"].includes(
    input.state,
  );
  const score =
    Math.round((delivered ? gates + criteria + review + cost : Math.min(gates, 10)) * 10) / 10;
  return {
    score,
    gates: Math.round(gates),
    criteria: Math.round(criteria),
    review,
    cost: Math.round(cost),
    costUsd: input.costUsd,
  };
}

export function compareEvals(
  baseline: EvalResult,
  candidate: EvalResult,
  tolerance = 2,
): { ok: boolean; delta: number; regressions: string[] } {
  const delta = Math.round((candidate.total - baseline.total) * 10) / 10;
  const regressions = candidate.tasks.flatMap((c) => {
    const b = baseline.tasks.find((t) => t.id === c.id);
    return b && c.score < b.score - tolerance ? [`${c.id} : ${b.score} → ${c.score}`] : [];
  });
  return { ok: candidate.total >= baseline.total - tolerance, delta, regressions };
}

function initRemote(fixtureDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "jules-eval-"));
  const remote = join(root, "repo.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, seed]);
  cpSync(fixtureDir, seed, { recursive: true });
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", [
    "-C",
    seed,
    "-c",
    "user.name=eval",
    "-c",
    "user.email=eval@jules",
    "commit",
    "-q",
    "-m",
    "chore: état de départ",
  ]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  return remote;
}

export type EvalRunOptions = {
  db: Db;
  driver: SandboxDriver;
  log: Logger;
  suiteDir: string;
  label: string;
  config: Omit<OrchestratorDeps["config"], "runsDir"> & { runsDir?: string };
  /** Nombre maximal d'étapes par tâche (exécutions et vérifications). */
  maxSteps?: number;
};

export async function runEvals(options: EvalRunOptions): Promise<EvalResult> {
  const scores: TaskScore[] = [];
  for (const [index, task] of loadSuite(options.suiteDir).entries()) {
    const github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "eval" });
    github.setRole("eval", "admin");
    const remote = initRemote(join(options.suiteDir, task.fixture));
    const owner = "eval";
    const name = `${options.label}-${task.id}`.replace(/[^\w-]/g, "-");
    github.remotes.set(`${owner}/${name}`, remote);
    const githubRepoId = 900_000 + Math.floor(Math.random() * 99_999);
    const [installation] = await options.db
      .insert(installations)
      .values({
        orgId: DEFAULT_ORG_ID,
        githubInstallationId: 77_000 + index + Math.floor(Math.random() * 900),
        accountLogin: owner,
        accountType: "Organization",
      })
      .returning();
    const [repo] = await options.db
      .insert(repos)
      .values({
        orgId: DEFAULT_ORG_ID,
        forge: "github",
        installationId: installation?.id,
        githubRepoId,
        fullName: `${owner}/${name}`,
        defaultBranch: "main",
        private: true,
        autonomy: "L2",
      })
      .returning();
    const [row] = await options.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId: repo?.id ?? "",
        agent: "developer",
        issueNumber: index + 1,
        title: task.issue.title,
        request: task.issue.body,
      })
      .returning();
    if (!row) continue;

    const orchestrator = new Orchestrator({
      db: options.db,
      github,
      driver: options.driver,
      log: options.log.child({ eval: task.id, label: options.label }),
      masker: new Masker([options.config.model.credential.secret]),
      config: {
        runsDir: options.config.runsDir ?? mkdtempSync(join(tmpdir(), "jules-eval-runs-")),
        ...options.config,
      },
    });
    const deps = {
      db: options.db,
      github,
      log: options.log,
      settings: { mention: "@jules", label: "jules", language: options.config.language },
    };
    for (let step = 0; step < (options.maxSteps ?? 20); step++) {
      const [current] = await options.db.select().from(tasks).where(eq(tasks.id, row.id));
      if (
        !current ||
        [
          "awaiting_human_review",
          "done",
          "blocked",
          "failed",
          "cancelled",
          "awaiting_info",
        ].includes(current.state)
      ) {
        break;
      }
      if (
        current.state === "awaiting_spec_approval" ||
        current.state === "awaiting_design_approval"
      ) {
        await options.db.transaction((tx) => applyTransition(tx, current, { type: "approve" }));
        continue;
      }
      await drainOutbox(deps);
      const started = await orchestrator.drainTasks();
      await orchestrator.idle();
      await drainOutbox(deps);
      if (started === 0) {
        // Rien à réserver : la vérification attend un push qui vient d'être fait.
        await options.db
          .update(tasks)
          .set({ resumeAfter: null, leaseUntil: null })
          .where(eq(tasks.id, row.id));
      }
    }

    const [final] = await options.db.select().from(tasks).where(eq(tasks.id, row.id));
    const latest = async (kind: string) =>
      (
        await options.db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.taskId, row.id), eq(artifacts.kind, kind)))
          .orderBy(desc(artifacts.version))
          .limit(1)
      )[0]?.content;
    const spec = (await latest("spec")) as { acceptanceCriteria: unknown[] } | undefined;
    const details = scoreTask({
      state: final?.state ?? "failed",
      gates: (await latest("gate_report")) as GateReport | undefined,
      review: (await latest("review")) as Review | undefined,
      acCount: spec?.acceptanceCriteria.length ?? 0,
      costUsd: Number(final?.costUsd ?? 0),
      budgetUsd: options.config.taskBudgetUsd ?? options.config.developer.budgetUsd * 4,
    });
    scores.push({ id: task.id, state: final?.state ?? "failed", score: details.score, details });
  }
  const total =
    scores.length === 0
      ? 0
      : Math.round((scores.reduce((s, t) => s + t.score, 0) / scores.length) * 10) / 10;
  return { label: options.label, total, tasks: scores };
}
