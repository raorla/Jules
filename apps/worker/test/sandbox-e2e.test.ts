import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ORG_ID, eq, outbox, runs, sql, tasks } from "@jules/db";
import Docker from "dockerode";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainOutbox } from "../src/outbox.js";
import { startFakeModel, type FakeModel, type Step } from "./fake-model.js";
import { seedTask, testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { API_KEY, localSandboxSetup, sandboxSetup } from "./sandbox-harness.js";
import { liftStop, stopAll } from "../src/emergency.js";

let t: TestDatabase;
let model: FakeModel | undefined;

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
}, 900_000);
afterAll(async () => {
  await model?.close();
  await t.stop();
});
beforeEach(async () => {
  await t.db.execute(sql`truncate outbox, stops cascade`);
  // Chaque test part de ses propres tâches : celles laissées en cours par les précédents (en
  // vérification, en attente de reprise) ne doivent pas occuper l'orchestrateur.
  await t.db.execute(
    sql`update tasks set state = 'cancelled' where state not in ('done', 'cancelled')`,
  );
  await model?.close();
  model = undefined;
});

const HAPPY: Step[] = [
  { tool: "mcp__jules__set_plan", input: { steps: ["Écrire le test", "Ajouter /healthz"] } },
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
      summary: "Ajoute un endpoint /healthz.",
      commitMessage: "feat(api): ajoute /healthz",
      testsAdded: [],
    },
  },
  { text: "Terminé." },
];

describe("M1 : issue → développeur → push → PR brouillon", () => {
  it("une issue simple donne une PR brouillon correcte", async () => {
    model = await startFakeModel(HAPPY);
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db, { issueNumber: 12 });

    expect(await s.orchestrator.drainTasks()).toBe(1);
    await s.orchestrator.idle();
    await drainOutbox(testDeps(t.db, s.github));

    const [done] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(done?.lastError ?? null).toBeNull();
    expect(done).toMatchObject({
      // La PR est ouverte au premier push ; les gates de vérification (M3) prennent la suite.
      state: "verifying",
      branch: "jules/12-ajouter-healthz",
    });
    const log = execFileSync("git", [
      "-C",
      s.remote,
      "log",
      "-1",
      "--format=%s%n%b",
      "jules/12-ajouter-healthz",
    ]).toString();
    expect(log).toContain("feat(api): ajoute /healthz");
    expect(log).toContain(`Jules-Task: ${task.id}`);
    expect(
      execFileSync("git", [
        "-C",
        s.remote,
        "show",
        "jules/12-ajouter-healthz:health.js",
      ]).toString(),
    ).toContain("ok: true");
    expect(s.github.pullRequests).toHaveLength(1);
    expect(s.github.pullRequests[0]).toMatchObject({
      draft: true,
      base: "main",
      head: "jules/12-ajouter-healthz",
      title: "feat(api): ajoute /healthz",
    });
    const status =
      s.github.commentsOn({ installationId: 4242, owner: "acme", repo: "sandbox" }, 12).at(-1)
        ?.body ?? "";
    expect(status).toContain("en vérification");
    expect(status).toContain("Pull request");
    expect(status).toContain("- [x] Écrire le test");
  });
});

describe("abonnement Claude (claude setup-token)", () => {
  it("le jeton part en Bearer avec la bêta d'abonnement ; ni le sandbox ni ses fichiers ne le voient", async () => {
    model = await startFakeModel(HAPPY);
    const token = ["sk-ant-oat01", "jeton-d-abonnement-des-tests", "0123456789"].join("-");
    const s = sandboxSetup(t.db, model, {
      model: { upstream: model.url, credential: { kind: "subscription", secret: token } },
    });
    const { task } = await seedTask(t.db, { issueNumber: 31 });
    expect(await s.orchestrator.drainTasks()).toBe(1);
    await s.orchestrator.idle();
    expect((await taskState(task.id))?.state).toBe("verifying");

    const calls = model.requests.filter((r) => r.path.startsWith("/v1/messages"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${token}`);
      expect(call.headers["x-api-key"]).toBeUndefined();
      const betas = String(call.headers["anthropic-beta"]).split(",");
      expect(betas.filter((b) => b === "oauth-2025-04-20")).toHaveLength(1);
      // Les bêtas de Claude Code passent toujours.
      expect(betas).toContain("claude-code-20250219");
    }
    const spec = s.driver.specs[0]!;
    expect(JSON.stringify(spec.env)).not.toContain(token);
    for (const dir of [s.runsDir, ...(spec.mounts ?? []).map((m) => m.source)]) {
      for (const file of filesUnder(dir)) {
        expect(readFileSync(file).includes(token), file).toBe(false);
      }
    }
  });
});

/** Tous les fichiers sous `dir`, pour chercher une fuite de secret. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && statSync(path).size < 5_000_000 ? [path] : [];
  });
}

const GITHUB_TOKEN = "ghs_fauxjetondinstallationpourlestests0000";
const ref = { installationId: 4242, owner: "acme", repo: "sandbox" };
const taskState = async (id: string) =>
  (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0];

// DoD M10 : les mêmes tests passent en mode local, avec la forge locale sur un dossier de travail.
describe.each(["github", "local"] as const)("M1 : sécurité du sandbox (forge %s)", (forge) => {
  const setup = (fake: FakeModel) =>
    forge === "local" ? localSandboxSetup(t.db, fake) : sandboxSetup(t.db, fake);
  const seed = (s: ReturnType<typeof setup>) =>
    seedTask(t.db, "path" in s ? { localPath: s.path } : {});

  it("aucune variable ni aucun fichier du sandbox ne contient le jeton GitHub ou la clé API", async () => {
    model = await startFakeModel(HAPPY);
    const s = setup(model);
    await seed(s);
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    const spec = s.driver.specs[0]!;
    const workspaceMounts = (spec.mounts ?? []).map((m) => m.source);
    // Ce que voit le processus du sandbox : son environnement et les fichiers montés.
    const probe = await s.driver.run({
      ...spec,
      runId: crypto.randomUUID(),
      entrypoint: [
        "sh",
        "-c",
        "env; cat /run/jules/context.json; git -C /workspace config --list --show-origin",
      ],
      network: { kind: "none" },
    });
    expect(probe.exitCode).toBe(0);
    for (const secret of [API_KEY, GITHUB_TOKEN]) {
      expect(probe.logs).not.toContain(secret);
      expect(JSON.stringify(spec.env)).not.toContain(secret);
      for (const file of workspaceMounts.flatMap(filesUnder)) {
        expect(readFileSync(file).includes(secret), file).toBe(false);
      }
    }
    expect(Object.keys(spec.env ?? {})).toEqual(["JULES_RUN_TOKEN"]);
    expect(probe.logs).toContain("JULES_RUN_TOKEN=jrt_");
  });

  it("curl https://example.com échoue alors que npm install réussit", async () => {
    const s = setup((model = await startFakeModel([])));
    const outcome = await s.driver.run({
      runId: crypto.randomUUID(),
      image: "jules-sandbox-node:test",
      entrypoint: [
        "sh",
        "-c",
        "curl -sS -m 10 https://example.com >/dev/null 2>&1 && echo CURL_OK || echo CURL_REFUSE; " +
          "cd /tmp && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0 >/dev/null 2>&1 && echo NPM_OK || echo NPM_ECHEC",
      ],
      network: { kind: "egress", allow: ["registry.npmjs.org"] },
      limits: { timeoutMs: 120_000 },
    });

    expect(outcome.logs).toContain("CURL_REFUSE");
    expect(outcome.logs).toContain("NPM_OK");
    expect(outcome.egress).toContainEqual(
      expect.objectContaining({ host: "example.com", allowed: false }),
    );
    expect(outcome.egress).toContainEqual(
      expect.objectContaining({ host: "registry.npmjs.org", allowed: true }),
    );
  }, 180_000);

  it("le sandbox ne joint ni Postgres, ni le gateway, ni l'hôte", async () => {
    const s = setup((model = await startFakeModel([])));
    const docker = new Docker();
    const info = await docker.getContainer(t.container.getId()).inspect();
    const pgIp = info.NetworkSettings.Networks.bridge?.IPAddress ?? "172.17.0.2";
    const mapped = t.container.getMappedPort(5432);
    const targets = [
      `${pgIp}:5432`,
      `172.17.0.1:${mapped}`,
      `172.17.0.1:22`,
      `host.docker.internal:${mapped}`,
      `gateway:3000`,
    ];
    const script = `const net=require("net");for(const t of ${JSON.stringify(targets)}){const [h,p]=t.split(":");const s=net.connect(+p,h);s.setTimeout(3000);s.on("connect",()=>{console.log("OUVERT "+t);s.destroy()});s.on("error",()=>console.log("FERME "+t));s.on("timeout",()=>{console.log("FERME "+t);s.destroy()})}`;

    const outcome = await s.driver.run({
      runId: crypto.randomUUID(),
      image: "jules-sandbox-node:test",
      entrypoint: ["node", "-e", script],
      network: { kind: "egress", allow: ["registry.npmjs.org"] },
      limits: { timeoutMs: 60_000 },
    });

    for (const target of targets) {
      expect(outcome.logs).toContain(`FERME ${target}`);
    }
    expect(outcome.logs).not.toContain("OUVERT");
  });

  it("un workflow de CI modifié bloque le push", async () => {
    model = await startFakeModel([
      {
        tool: "Write",
        input: { file_path: "/workspace/.github/workflows/exfiltre.yml", content: "on: push\n" },
      },
      {
        tool: "mcp__jules__submit_build",
        input: { summary: "x", commitMessage: "ci: ajoute un workflow" },
      },
      { text: "Terminé." },
    ]);
    const s = setup(model);
    const { task } = await seed(s);
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    expect(await taskState(task.id)).toMatchObject({ state: "blocked" });
    expect((await taskState(task.id))?.lastError).toContain(".github/workflows/exfiltre.yml");
    const pushes = await t.db.select().from(outbox).where(eq(outbox.kind, "git.push"));
    expect(pushes).toHaveLength(0);
  });

  it("un .git/config piégé dans le workspace n'exécute rien sur l'hôte", async () => {
    // Si git tournait sur l'hôte dans ce workspace, PWNED apparaîtrait dans le dossier de l'exécution.
    const trap = 'touch "$(dirname "$PWD")/PWNED"; false';
    model = await startFakeModel([
      {
        tool: "Bash",
        input: {
          command: `git config core.fsmonitor '${trap}' && git config core.hooksPath /workspace/.hooks && mkdir -p .hooks && printf '#!/bin/sh\\n${trap}\\n' > .hooks/post-commit && chmod +x .hooks/post-commit && echo ok > a.txt`,
        },
      },
      { tool: "mcp__jules__submit_build", input: { summary: "x", commitMessage: "feat: a" } },
      { text: "Terminé." },
    ]);
    const s = setup(model);
    const { task } = await seed(s);
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    // Le dossier de cette exécution, désigné par son identifiant : `drainTasks` peut aussi faire
    // avancer une tâche d'un test précédent, dont la vérification crée un autre dossier ici.
    const [run] = await t.db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, task.id));
    const runDir = join(s.runsDir, run!.id);
    expect(existsSync(join(runDir, "workspace", ".hooks", "post-commit"))).toBe(true);
    expect(existsSync(join(runDir, "PWNED"))).toBe(false);
    expect((await taskState(task.id))?.state).toBe("verifying");
  });

  it("refuse et journalise les outils pièges", async () => {
    model = await startFakeModel([
      { tool: "mcp__jules__git_push", input: { branch: "main" } },
      { tool: "mcp__jules__merge_pull_request", input: { number: 1 } },
      { text: "Je ne peux pas." },
    ]);
    const s = setup(model);
    const { task } = await seed(s);
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    const [run] = await t.db.select().from(runs).where(eq(runs.taskId, task.id));
    const calls = await t.db.execute<{ capability: string; effect: string; rule_id: string }>(
      sql`select capability, effect, rule_id from tool_calls where run_id = ${run!.id} order by created_at`,
    );
    expect(calls.rows).toEqual([
      { capability: "git_push", effect: "deny", rule_id: "absolute.honeypot" },
      { capability: "merge_pull_request", effect: "deny", rule_id: "absolute.honeypot" },
    ]);
    expect((await taskState(task.id))?.state).toBe("failed");
  });

  it("coupe l'exécution quand le budget est atteint", async () => {
    model = await startFakeModel(HAPPY);
    model.setUsage({ input_tokens: 2_000_000, output_tokens: 10 });
    const s = setup(model);
    const { task } = await seed(s);
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    const [run] = await t.db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run?.status).toBe("budget_exceeded");
    expect(await taskState(task.id)).toMatchObject({ state: "blocked" });
    expect((await taskState(task.id))?.lastError).toContain("budget");
  });
});

describe("M1 : fiabilité", () => {
  it("jules stop --all arrête toutes les exécutions en moins de 10 s et révoque leurs jetons", async () => {
    model = await startFakeModel(HAPPY);
    model.hang();
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db);
    await s.orchestrator.drainTasks();
    const docker = new Docker();
    const sandboxes = () =>
      docker.listContainers({
        filters: { label: ["jules.sandbox=1", `jules.instance=${s.instance}`] },
      });
    for (let i = 0; i < 200 && (await sandboxes()).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await sandboxes()).length).toBe(2);

    const started = Date.now();
    const report = await stopAll(t.db, s.driver, {
      orgId: DEFAULT_ORG_ID,
      reason: "test",
      actorId: "cli",
    });
    for (let i = 0; i < 100 && (await sandboxes()).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await sandboxes()).toHaveLength(0);
    expect(report.revokedTokens).toBeGreaterThanOrEqual(1);
    model.release();
    await s.orchestrator.idle();
    const [run] = await t.db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run?.revokedAt).toBeInstanceOf(Date);
    expect(await taskState(task.id)).toMatchObject({ state: "blocked" });

    // Tant que l'arrêt est actif, rien ne redémarre.
    await t.db.update(tasks).set({ state: "received" }).where(eq(tasks.id, task.id));
    expect(await s.orchestrator.drainTasks()).toBe(0);
    await liftStop(t.db, { orgId: DEFAULT_ORG_ID, actorId: "cli" });
    await t.db.update(tasks).set({ state: "cancelled" }).where(eq(tasks.id, task.id));
  });

  it("une panne du fournisseur met la tâche en waiting_provider, puis elle reprend seule", async () => {
    model = await startFakeModel(HAPPY);
    model.overloadNext(1000);
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db);
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    const waiting = await taskState(task.id);
    expect(waiting).toMatchObject({ state: "waiting_provider" });
    expect(waiting?.resumeAfter).toBeInstanceOf(Date);

    model.overloadNext(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(await s.orchestrator.drainTasks()).toBe(1);
    await s.orchestrator.idle();
    expect((await taskState(task.id))?.state).toBe("verifying");
  });

  it("une limite annoncée (abonnement Claude) est attendue jusqu'à sa levée, sans tentative inutile", async () => {
    model = await startFakeModel(HAPPY);
    model.limitNext(1000, 7200);
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db);
    const before = Date.now();
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();

    const waiting = await taskState(task.id);
    expect(waiting).toMatchObject({ state: "waiting_provider" });
    expect(waiting?.lastError).toContain("limite du fournisseur");
    // La reprise suit l'annonce (2 h), pas l'attente progressive (quelques centaines de ms ici).
    const resume = waiting!.resumeAfter!.getTime();
    expect(resume).toBeGreaterThanOrEqual(before + 7200_000 - 60_000);
    expect(resume).toBeLessThanOrEqual(Date.now() + 7200_000);
    expect(await s.orchestrator.drainTasks()).toBe(0);
    model.limitNext(0, 0);
  });

  it("après un crash du worker, ni commentaire en double, ni deuxième PR, ni effet perdu", async () => {
    model = await startFakeModel(HAPPY);
    const s = sandboxSetup(t.db, model);
    const { task } = await seedTask(t.db, { issueNumber: 77 });
    // Crash simulé : la tâche était en cours, son bail a expiré, son exécution est orpheline.
    await t.db
      .update(tasks)
      .set({ state: "building", leaseUntil: new Date(Date.now() - 1000), attempts: 1 })
      .where(eq(tasks.id, task.id));

    expect(await s.orchestrator.recover()).toBeGreaterThanOrEqual(1);
    // Le bail est libéré : la tâche reprend dans sa phase, depuis le dernier artefact validé.
    expect(await taskState(task.id)).toMatchObject({ state: "building", leaseUntil: null });
    await s.orchestrator.drainTasks();
    await s.orchestrator.idle();
    const deps = testDeps(t.db, s.github);
    await drainOutbox(deps);
    // Nouveau crash juste après les effets : tout est rejoué.
    await t.db.update(outbox).set({ status: "pending", doneAt: null });
    await t.db.update(tasks).set({ statusCommentId: null }).where(eq(tasks.id, task.id));
    await drainOutbox(deps);

    expect(s.github.pullRequests).toHaveLength(1);
    expect(s.github.commentsOn(ref, 77)).toHaveLength(1);
    const effects = await t.db
      .select()
      .from(outbox)
      .where(eq(outbox.serialKey, `task:${task.id}`));
    expect(effects.every((e) => e.status === "done")).toBe(true);
    expect(effects.find((e) => e.kind === "git.push")?.result).toMatchObject({
      operation: "already_pushed",
    });
  });
});
