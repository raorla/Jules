import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ORG_ID,
  and,
  eq,
  localChecks,
  localComments,
  localItems,
  outbox,
  events,
  registerLocalRepo,
  repos,
  sql,
  tasks,
  users,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { SecretStore, generateMasterKey } from "@jules/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANTHROPIC_KEY_SECRET } from "../src/config.js";
import { drainEvents } from "../src/inbox.js";
import { HandoffError, receiveHandoff } from "../src/local/handoff.js";
import { applyTransition } from "../src/transitions.js";
import { drainOutbox } from "../src/outbox.js";
import { startFakeModel, type FakeModel, type Scripts, type Step } from "./fake-model.js";
import { testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { API_KEY, ROOT, localSandboxSetup } from "./sandbox-harness.js";

// Definition of Done de M10 (ROADMAP.md) : le pipeline développeur complet tourne sur un dossier
// local, sans GitHub, jusqu'au merge par le bouton de l'app ; et aucun secret n'est écrit en clair sur
// le disque. Les tests de sécurité de M1 rejoués en mode local sont dans sandbox-e2e.test.ts.

let t: TestDatabase;
let model: FakeModel;

const done: Step = { text: "Terminé." };
const MUL_TEST =
  'import test from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/math.js";\n\ntest("mul", () => {\n  assert.equal(mul(2, 3), 6);\n});\n';
const MATH =
  "export function sum(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n";

const SCRIPTS: Scripts = {
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
          { id: "AC-1", given: "deux nombres", when: "on appelle mul", then: "leur produit" },
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
  build: [
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
  learn: [
    {
      tool: "mcp__jules__propose_lessons",
      input: {
        lessons: [{ text: "Les fonctions de calcul vivent dans src/math.js.", source: "merge" }],
      },
    },
    done,
  ],
};

/**
 * Ce que fait le desktop au lancement de la pile (apps/desktop/core/src/handoff.rs) : un point
 * d'accès éphémère sur un socket Unix, une seule remise, jeton exigé.
 */
function desktopHandoff(secrets: { masterKey: string; anthropicApiKey?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "jules-handoff-"));
  const socket = join(dir, "handoff.sock");
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  let served = false;
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (served) {
      res.writeHead(410).end();
      return;
    }
    served = true;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(secrets));
  });
  return new Promise<{ url: string; token: string; close: () => void }>((resolve) => {
    server.listen(socket, () => {
      resolve({ url: `unix:${socket}`, token, close: () => server.close() });
    });
  });
}

/** Tous les fichiers sous `dir`, dossiers .git compris. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f, { throwIfNoEntry: false })?.isFile());
}

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
  model = await startFakeModel(SCRIPTS);
}, 900_000);
afterAll(async () => {
  await model.close();
  await t.stop();
});

describe("M10 : mode local", () => {
  it("issue → spec → conception → TDD → gates → review → merge par le bouton, sur un dossier local", async () => {
    // Le desktop remet la clé maître ; la clé API est scellée en base, comme en mode serveur.
    const masterKey = generateMasterKey();
    const handoff = await desktopHandoff({ masterKey });
    const { keyring } = await receiveHandoff(handoff.url, handoff.token);
    await expect(receiveHandoff(handoff.url, handoff.token)).rejects.toThrow(HandoffError);
    await expect(receiveHandoff(handoff.url, "faux".repeat(16))).rejects.toThrow(/401/);
    handoff.close();
    const store = new SecretStore(t.db, keyring);
    await store.set(DEFAULT_ORG_ID, ANTHROPIC_KEY_SECRET, API_KEY);
    expect((await store.get(DEFAULT_ORG_ID, ANTHROPIC_KEY_SECRET))?.toString()).toBe(API_KEY);
    await expect(receiveHandoff("http://192.0.2.10:4000/handoff", handoff.token)).rejects.toThrow(
      /bouclage/,
    );

    const s = localSandboxSetup(t.db, model);
    const deps = testDeps(t.db, s.forge);
    const g = (...args: string[]) =>
      execFileSync("git", ["-C", s.path, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
        .toString()
        .trim();
    cpSync(join(ROOT, "evals", "fixtures", "node-basic"), s.path, { recursive: true });
    g("add", "-A");
    g("commit", "-q", "-m", "chore: projet");

    // Comme le bouton « Ajouter un dossier » puis « Nouvelle tâche » de l'app (routes de l'api).
    const repo = await registerLocalRepo(t.db, { orgId: DEFAULT_ORG_ID, path: s.path });
    await t.db.update(repos).set({ autonomy: "L2" }).where(eq(repos.id, repo.id));
    const [task] = await t.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId: repo.id,
        agent: "developer",
        title: "Ajouter une multiplication",
        request: "Ajoute une fonction `mul(a, b)` dans `src/math.js`, avec ses tests.",
      })
      .returning();
    await t.db.insert(outbox).values({
      orgId: DEFAULT_ORG_ID,
      kind: "github.create_issue",
      idempotencyKey: `task:${task!.id}:issue`,
      serialKey: `task:${task!.id}`,
      payload: { taskId: task!.id, requester: "ada" },
    });

    const state = async () => (await t.db.select().from(tasks).where(eq(tasks.id, task!.id)))[0]!;
    const approvals: string[] = [];
    for (let step = 0; step < 20 && (await state()).state !== "awaiting_human_review"; step++) {
      const current = await state();
      if (["awaiting_spec_approval", "awaiting_design_approval"].includes(current.state)) {
        // H1 et H2 : la personne approuve depuis l'app (commande web, prouvée en M6).
        approvals.push(current.state);
        await t.db.transaction((tx) => applyTransition(tx, current, { type: "approve" }));
        continue;
      }
      await drainOutbox(deps);
      const started = await s.orchestrator.drainTasks();
      await s.orchestrator.idle();
      await drainOutbox(deps);
      if (started === 0) {
        await t.db
          .update(tasks)
          .set({ resumeAfter: null, leaseUntil: null })
          .where(eq(tasks.id, task!.id));
      }
    }
    const reviewed = await state();
    // Risque moyen sur une fonctionnalité : H1 seulement (WORKFLOW.md §3).
    expect(approvals).toEqual(["awaiting_spec_approval"]);
    expect(reviewed).toMatchObject({ state: "awaiting_human_review", issueNumber: 1, prNumber: 2 });
    expect(reviewed.prUrl).toBe("local:sandbox#2");

    // Tout est dans le dossier et dans la base : branche, demande de merge, checks, review, statut.
    const branch = reviewed.branch!;
    expect(g("rev-parse", `refs/heads/${branch}`)).toBe(reviewed.headSha);
    expect(g("symbolic-ref", "--short", "HEAD")).toBe("main");
    const items = await t.db.select().from(localItems).where(eq(localItems.repoId, repo.id));
    expect(items.map((i) => [i.number, i.kind, i.state])).toEqual(
      expect.arrayContaining([
        [1, "issue", "open"],
        [2, "merge_request", "open"],
      ]),
    );
    expect(items.find((i) => i.number === 2)).toMatchObject({ head: branch, draft: false });
    const checks = await t.db
      .select()
      .from(localChecks)
      .where(and(eq(localChecks.repoId, repo.id), eq(localChecks.sha, reviewed.headSha!)));
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual(
      expect.arrayContaining([
        ["Jules / gates", "success"],
        ["Jules / review", "success"],
      ]),
    );
    const comments = await t.db
      .select()
      .from(localComments)
      .where(eq(localComments.repoId, repo.id));
    expect(comments.some((c) => c.kind === "review" && c.number === 2)).toBe(true);
    expect(comments.some((c) => c.kind === "comment" && c.number === 1)).toBe(true);

    // Le bouton « Merger » de l'app : l'api écrit l'effet, le worker merge dans le dossier.
    const [merger] = await t.db
      .insert(users)
      .values({ orgId: DEFAULT_ORG_ID, login: "ada", kind: "human" })
      .returning();
    await t.db.insert(outbox).values({
      orgId: DEFAULT_ORG_ID,
      kind: "local.merge",
      idempotencyKey: `task:${task!.id}:merge:1`,
      serialKey: `task:${task!.id}`,
      payload: { taskId: task!.id, userId: merger!.id },
    });
    await drainOutbox(deps);
    const [effect] = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.kind, "local.merge"), eq(outbox.serialKey, `task:${task!.id}`)));
    expect(effect).toMatchObject({ status: "done", result: { operation: "merged" } });
    expect(g("log", "-1", "--format=%an %s", "main")).toBe("ada Merge !2 : feat: ajoute mul");
    expect(g("show", "main:src/math.js")).toContain("export function mul(a, b)");
    expect(readFileSync(join(s.path, "src", "math.js"), "utf8")).toContain("mul");

    // Comme un webhook : la tâche passe au retour d'expérience, puis se termine.
    await drainEvents(deps);
    expect((await state()).state).toBe("learning");
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();
    await drainOutbox(deps);
    expect((await state()).state).toBe("done");
    const closed = await t.db
      .select()
      .from(localItems)
      .where(and(eq(localItems.repoId, repo.id), eq(localItems.number, 1)));
    expect(closed[0]?.state).toBe("closed");

    // DoD : aucun secret en clair sur le disque, ni dans les fichiers de Jules, ni dans le dossier,
    // ni dans les fichiers de PostgreSQL (WAL compris).
    const needles = [API_KEY, masterKey, handoff.token];
    for (const file of [...filesUnder(s.runsDir), ...filesUnder(s.path)]) {
      const content = readFileSync(file);
      for (const needle of needles) {
        expect(content.includes(needle), file).toBe(false);
      }
    }
    // Contrôle : un texte témoin écrit en base est bien retrouvé par le même balayage.
    const canary = `temoin-${crypto.randomUUID()}`;
    await t.db
      .insert(events)
      .values({ orgId: DEFAULT_ORG_ID, deliveryId: canary, event: "temoin" });
    await t.db.execute(sql`checkpoint`);
    // BusyBox (image alpine) : -l lit aussi les fichiers binaires ; code 0 trouvé, 1 absent.
    const found = async (needle: string) => {
      const { exitCode } = await t.container.exec([
        "grep",
        "-rlsF",
        "-e",
        needle,
        "/var/lib/postgresql",
      ]);
      expect([0, 1]).toContain(exitCode);
      return exitCode === 0;
    };
    expect(await found(canary)).toBe(true);
    for (const needle of needles) {
      expect(await found(needle), needle.slice(0, 12)).toBe(false);
    }
  }, 900_000);
});
