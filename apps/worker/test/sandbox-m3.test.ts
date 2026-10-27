import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, artifacts, desc, eq, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import type { GateReport } from "@jules/gates";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeModel, type FakeModel } from "./fake-model.js";
import { drainOutbox } from "../src/outbox.js";
import { seedTask, testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { sandboxSetup } from "./sandbox-harness.js";

// Definition of Done de M3 (ROADMAP.md) : un jeu de PR piégées est entièrement bloqué.
// Chaque branche est construite dans un vrai dépôt ; les gates tournent dans le vrai conteneur.

let t: TestDatabase;
let model: FakeModel;
let osv: Server;
let osvUrl: string;
let seed: string;
let s: ReturnType<typeof sandboxSetup>;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
    .toString()
    .trim();

function write(path: string, content: string) {
  mkdirSync(dirname(join(seed, path)), { recursive: true });
  writeFileSync(join(seed, path), content);
}

const BASE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "sandbox",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        test: "node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info --test-reporter=spec --test-reporter-destination=stdout 'test/**/*.test.js'",
      },
    },
    null,
    2,
  ),
  "src/sum.js": "export const sum = (a, b) => a + b;\n",
  "test/sum.test.js":
    'import test from "node:test";\nimport assert from "node:assert";\nimport { sum } from "../src/sum.js";\n\ntest("sum", () => {\n  assert.equal(sum(1, 2), 3);\n});\n',
  ".jules/config.yml":
    "version: 1\ncommands:\n  test: npm test\ncoverage:\n  report: lcov.info\ngates:\n  diff_coverage_min: 80\n",
};

type Change = { path: string; content?: string };
type Commit = { message: string; changes: Change[] };

/** Construit la branche piégée depuis main et renvoie la tâche prête à vérifier. */
async function trap(branch: string, commits: Commit[], type = "feature") {
  const { task } = await seedTask(t.db, { title: branch });
  git("checkout", "-q", "main");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", branch);
  for (const commit of commits) {
    for (const change of commit.changes) {
      if (change.content === undefined) {
        rmSync(join(seed, change.path));
      } else {
        write(change.path, change.content);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", `${commit.message}\n\nJules-Task: ${task.id}`);
  }
  git("push", "-q", "origin", branch);
  const head = git("rev-parse", "HEAD");
  await t.db
    .update(tasks)
    .set({ state: "verifying", type, risk: "medium", baseSha: base, headSha: head, branch })
    .where(eq(tasks.id, task.id));
  const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
  return row!;
}

async function verify(branch: string, commits: Commit[], type?: string) {
  const task = await trap(branch, commits, type);
  await s.orchestrator.verifyTask(task);
  await drainOutbox(testDeps(t.db, s.github));
  const [after] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
  const [report] = await t.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, task.id), eq(artifacts.kind, "gate_report")))
    .orderBy(desc(artifacts.version))
    .limit(1);
  const gates = report?.content as GateReport | undefined;
  const status = (id: string) => gates?.results.find((r) => r.id === id)?.status;
  return { task: after!, gates, status };
}

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
  osv = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url === "/v1/querybatch") {
        const { queries } = JSON.parse(body) as {
          queries: { package: { name: string }; version: string }[];
        };
        res.end(
          JSON.stringify({
            results: queries.map((q) =>
              q.package.name === "lodash" && q.version === "4.17.20"
                ? { vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] }
                : {},
            ),
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "GHSA-35jh-r3h4-6jhm",
            summary: "Command Injection in lodash",
            database_specific: { severity: "HIGH" },
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => osv.listen(0, "127.0.0.1", r));
  osvUrl = `http://127.0.0.1:${(osv.address() as AddressInfo).port}`;
  model = await startFakeModel([]);
  s = sandboxSetup(t.db, model, { osv: { baseUrl: osvUrl } });
  // main : un petit projet Node avec ses tests, sa couverture lcov et sa config Jules.
  seed = mkdtempSync(join(tmpdir(), "jules-m3-"));
  execFileSync("git", ["clone", "-q", s.remote, seed]);
  git("checkout", "-q", "main");
  for (const [path, content] of Object.entries(BASE_FILES)) write(path, content);
  git("add", "-A");
  git("commit", "-q", "-m", "chore: projet de test");
  git("push", "-q", "origin", "main");
}, 900_000);
afterAll(async () => {
  osv.close();
  await model.close();
  await t.stop();
});

const MUL_TEST =
  'import test from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/mul.js";\n\ntest("mul", () => {\n  assert.equal(mul(2, 3), 6);\n});\n';
const MUL = "export const mul = (a, b) => a * b;\n";

describe("M3 : gates de vérification", () => {
  it("une PR propre, tests d'abord et couverte, passe toutes les gates", async () => {
    const { task, gates } = await verify(
      "jules/1-mul",
      [
        { message: "test: mul", changes: [{ path: "test/mul.test.js", content: MUL_TEST }] },
        { message: "feat: ajoute mul", changes: [{ path: "src/mul.js", content: MUL }] },
      ],
      "bug",
    );
    expect(gates?.results.filter((r) => r.status === "fail")).toEqual([]);
    expect(gates?.results.find((r) => r.id === "G5.6")?.details).toMatch(/^100 %/);
    expect(gates?.results.find((r) => r.id === "G5.7")?.status).toBe("pass");
    expect(task.state).toBe("reviewing");
    const checks = s.github.checkRuns.get(task.headSha!) ?? [];
    expect(checks.find((c) => c.name === "Jules / gates")).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  }, 180_000);

  it.each([
    [
      "un secret dans le code",
      "jules/2-secret",
      [
        {
          message: "feat: config",
          changes: [
            { path: "src/config.js", content: 'export const key = "AKIAABCDEFGHIJKLMNOP";\n' },
          ],
        },
      ],
      "G4.2",
      "feature",
    ],
    [
      "une dépendance vulnérable",
      "jules/3-lodash",
      [
        {
          message: "build: ajoute lodash",
          changes: [
            {
              path: "package-lock.json",
              content: JSON.stringify({
                lockfileVersion: 3,
                packages: { "": {}, "node_modules/lodash": { version: "4.17.20" } },
              }),
            },
          ],
        },
      ],
      "G5.11",
      "feature",
    ],
    [
      "un test supprimé",
      "jules/4-deltest",
      [{ message: "test: nettoie", changes: [{ path: "test/sum.test.js" }] }],
      "G5.8",
      "feature",
    ],
    [
      "un .skip ajouté",
      "jules/5-skip",
      [
        {
          message: "test: désactive",
          changes: [
            {
              path: "test/sum.test.js",
              content: BASE_FILES["test/sum.test.js"]!.replace('test("sum"', 'test.skip("sum"'),
            },
          ],
        },
      ],
      "G5.8",
      "feature",
    ],
    [
      "un seuil de couverture abaissé dans la config de la branche (ignoré : config lue sur main)",
      "jules/6-seuil",
      [
        {
          message: "feat: extra sans test",
          changes: [
            {
              path: ".jules/config.yml",
              content: BASE_FILES[".jules/config.yml"]!.replace(
                "diff_coverage_min: 80",
                "diff_coverage_min: 0",
              ),
            },
            {
              path: "src/extra.js",
              content:
                "export function extra(x) {\n  if (x > 0) {\n    return x * 2;\n  }\n  return -x;\n}\n",
            },
          ],
        },
      ],
      "G5.6",
      "feature",
    ],
    [
      "un diff non couvert par les tests",
      "jules/7-uncovered",
      [
        {
          message: "feat: extra",
          changes: [
            { path: "src/extra.js", content: "export function extra(x) {\n  return x * 2;\n}\n" },
          ],
        },
      ],
      "G5.6",
      "feature",
    ],
    [
      "un bug corrigé sans test qui échoue sur la base",
      "jules/8-bug",
      [
        {
          message: "fix: sum",
          changes: [
            {
              path: "src/sum.js",
              content: "export const sum = (a, b) => Number(a) + Number(b);\n",
            },
          ],
        },
      ],
      "G5.7",
      "bug",
    ],
    [
      "un workflow de CI modifié",
      "jules/9-ci",
      [
        {
          message: "ci: exfiltre",
          changes: [{ path: ".github/workflows/x.yml", content: "on: push\n" }],
        },
      ],
      "G4.1",
      "feature",
    ],
  ] as [string, string, Commit[], string, string][])(
    "bloque %s",
    async (_, branch, commits, gate, type) => {
      const { task, status, gates } = await verify(branch, commits, type);
      expect(status(gate), JSON.stringify(gates?.results.filter((r) => r.status !== "pass"))).toBe(
        "fail",
      );
      expect(task.state).toBe("building");
      expect(task.iterations).toBe(1);
      expect(
        s.github.checkRuns.get(task.headSha!)?.find((c) => c.name === "Jules / gates")?.conclusion,
      ).toBe("failure");
    },
    180_000,
  );

  it("attend la CI du projet, puis la prend en compte", async () => {
    const task = await trap("jules/10-ci-en-cours", [
      { message: "test: mul", changes: [{ path: "test/mul.test.js", content: MUL_TEST }] },
      { message: "feat: ajoute mul", changes: [{ path: "src/mul.js", content: MUL }] },
    ]);
    s.github.setProjectCheck(task.headSha!, "build", "in_progress", null);
    await s.orchestrator.verifyTask(task);
    const [waiting] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(waiting).toMatchObject({ state: "verifying", leaseUntil: null });
    expect(waiting?.resumeAfter).toBeInstanceOf(Date);

    s.github.setProjectCheck(task.headSha!, "build", "completed", "failure");
    await s.orchestrator.verifyTask(waiting!);
    const [failed] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(failed?.state).toBe("building");
    expect(failed?.lastError).toContain("G5.14");
  }, 240_000);

  it("redemande H2 quand le risque réel dépasse ce qui a été approuvé, puis reprend en review", async () => {
    const task = await trap(
      "jules/12-deps",
      [
        {
          message: "docs: dépendance documentée",
          changes: [
            {
              path: "package.json",
              content: BASE_FILES["package.json"]!.replace(
                '"private": true',
                '"private": true,\n  "dependencies": { "is-number": "7.0.0" }',
              ),
            },
          ],
        },
      ],
      "docs",
    );
    await t.db.update(tasks).set({ risk: "low", autonomy: "L2" }).where(eq(tasks.id, task.id));
    const [low] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    await s.orchestrator.verifyTask(low!);
    const [after] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after).toMatchObject({
      state: "awaiting_design_approval",
      resumeState: "reviewing",
      risk: "medium",
    });
    expect(after?.lastError).toContain("risque réel medium");
  }, 180_000);

  it("bloque une migration non approuvée (chemin protégé, risque high)", async () => {
    const task = await trap("jules/11-migration", [
      { message: "test: mul", changes: [{ path: "test/mul.test.js", content: MUL_TEST }] },
      {
        message: "feat: ajoute mul et une migration",
        changes: [
          { path: "src/mul.js", content: MUL },
          { path: "db/migrations/0002_mul.sql", content: "-- rien\n" },
        ],
      },
    ]);
    await t.db.update(tasks).set({ risk: "low" }).where(eq(tasks.id, task.id));
    const [low] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    await s.orchestrator.verifyTask(low!);
    const [after] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    // La migration est un chemin protégé (G4.1) et passe le risque à high.
    expect(after?.state).toBe("building");
    expect(after?.lastError).toContain("G4.1");
  }, 180_000);
});
