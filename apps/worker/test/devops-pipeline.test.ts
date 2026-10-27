import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_ORG_ID, changePlans, deployments, eq, users } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { FakeGitHub } from "@jules/forge/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { devopsBench, remoteWithFiles, type DevopsBench } from "./devops-harness.js";
import { storeEvent, testDeps } from "./harness.js";

// DoD M7 : un déploiement complet staging → production, avec un retour arrière déclenché
// volontairement en staging (WORKFLOW.md §12.2). Vrais serveurs SSH, vrai git, faux GitHub.

let t: TestDatabase;
let bench: DevopsBench;
let health: Server;
let github: FakeGitHub;
let repo: ReturnType<typeof remoteWithFiles>;
let staging: Awaited<ReturnType<DevopsBench["addServer"]>>;
let production: Awaited<ReturnType<DevopsBench["addServer"]>>;
const broken = new Set<string>();
let pr = 100;

beforeAll(async () => {
  t = await startTestDatabase();
  // Le service déployé : sain, sauf pour les versions marquées cassées.
  health = createServer((req, res) => {
    const ref = req.url?.split("/").pop() ?? "";
    res.statusCode = broken.has(ref) ? 500 : 200;
    res.end();
  });
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const port = (health.address() as AddressInfo).port;
  repo = remoteWithFiles({
    ".jules/config.yml": [
      "version: 1",
      "deploy:",
      "  staging: { server: web-staging, playbook: deploy }",
      "  production: { server: web-prod, playbook: deploy }",
      "",
    ].join("\n"),
    ".jules/playbooks.yml": [
      "playbooks:",
      "  deploy:",
      "    params:",
      "      ref: { type: git_sha, required: true }",
      "    steps:",
      "      - run: echo {{ref}} > /tmp/current",
      "    verify:",
      "      - run: cat /tmp/current",
      `      - http: http://127.0.0.1:${port}/health/{{ref}}`,
      "        within: 2s",
      "    rollback:",
      "      - run: echo {{previous_ref}} > /tmp/current",
      "",
    ].join("\n"),
  });
  github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" });
  github.remotes.set("acme/sandbox", repo.remote);
  bench = devopsBench(t.db, { github });
  const row = await bench.repo();
  staging = await bench.addServer({
    name: "web-staging",
    environment: "staging",
    level: "D2",
    repoId: row.id,
  });
  production = await bench.addServer({
    name: "web-prod",
    environment: "production",
    level: "D3",
    repoId: row.id,
  });
}, 600_000);
afterAll(async () => {
  health.close();
  await bench.stop();
  await t.stop();
});

/** Une PR mergée sur main, avec sa CI verte : le webhook passe par l'inbox comme en production. */
async function merge(): Promise<string> {
  pr += 1;
  const sha = repo.commit({ [`changes/${pr}.txt`]: `PR ${pr}\n` });
  github.setProjectCheck(sha, "ci", "completed", "success");
  const payload = {
    action: "closed",
    installation: { id: 4242 },
    repository: { id: 99, name: "sandbox", owner: { login: "acme" }, default_branch: "main" },
    sender: { id: 1, login: "alice", type: "User" },
    pull_request: {
      number: pr,
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: sha,
      base: { ref: "main" },
    },
  };
  await storeEvent(t.db, "pull_request", payload);
  const deps = testDeps(t.db, github);
  await drainEvents(deps);
  return sha;
}

/** Une passe du worker : pipeline, plans, puis effets GitHub. */
async function tick() {
  await bench.deployments.advance();
  await bench.plans.drain();
  await drainOutbox(testDeps(t.db, github));
}

const deploymentsOf = (sha: string) =>
  t.db.select().from(deployments).where(eq(deployments.ref, sha)).orderBy(deployments.createdAt);
const statusesOf = (sha: string, environment: string) =>
  github.deployments
    .find((d) => d.sha === sha && d.environment === environment)
    ?.statuses.map((s) => s.state);

describe("pipeline de déploiement (WORKFLOW.md §12.2)", () => {
  it("déploie en staging, attend l'approbation avec passkey, puis déploie en production", async () => {
    const sha = await merge();
    await tick();
    const [stagingDeployment, productionDeployment] = await deploymentsOf(sha);
    expect(stagingDeployment).toMatchObject({
      environment: "staging",
      status: "succeeded",
      pullRequests: [pr],
    });
    expect((await staging.host.exec("cat /tmp/current")).trim()).toBe(sha);
    expect(statusesOf(sha, "staging")).toEqual(["in_progress", "success"]);

    // La production attend un humain, même en D3.
    await tick();
    const [, waiting] = await deploymentsOf(sha);
    expect(waiting).toMatchObject({
      environment: "production",
      status: "pending_approval",
      promotedFrom: stagingDeployment!.id,
    });
    expect(productionDeployment?.environment).toBe("production");
    expect(statusesOf(sha, "production")).toEqual(["queued"]);

    const [maya] = await t.db
      .insert(users)
      .values({ orgId: DEFAULT_ORG_ID, login: "maya", kind: "human" })
      .returning();
    const [plan] = await t.db
      .select()
      .from(changePlans)
      .where(eq(changePlans.id, waiting!.planId!));
    const approve = (stepUp: boolean) =>
      t.db.transaction((tx) =>
        bench.plans.decideOn(tx, plan!, "approve", {
          userId: maya!.id,
          role: "maintainer",
          source: "web",
          stepUp,
        }),
      );
    expect(await approve(false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("passkey"),
    });
    expect(await approve(true)).toMatchObject({ ok: true });
    await tick();
    const [, deployed] = await deploymentsOf(sha);
    expect(deployed?.status).toBe("succeeded");
    expect((await production.host.exec("cat /tmp/current")).trim()).toBe(sha);
    expect(statusesOf(sha, "production")).toEqual(["queued", "success"]);
  });

  it("revient en arrière en staging quand la vérification échoue, et n'envoie rien en production", async () => {
    const before = (await staging.host.exec("cat /tmp/current")).trim();
    const sha = await merge();
    broken.add(sha);
    await tick();
    const rows = await deploymentsOf(sha);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      environment: "staging",
      status: "rolled_back",
      previousRef: before,
    });
    expect((await staging.host.exec("cat /tmp/current")).trim()).toBe(before);
    expect(statusesOf(sha, "staging")).toEqual(["in_progress", "failure"]);
    await tick();
    expect(await deploymentsOf(sha)).toHaveLength(1);
  });

  it("s'arrête quand la CI du commit est rouge", async () => {
    pr += 1;
    const sha = repo.commit({ [`changes/${pr}.txt`]: "rouge\n" });
    github.setProjectCheck(sha, "ci", "completed", "failure");
    await t.db.transaction(async (tx) => {
      const { requestDeployment } = await import("../src/devops/deployments.js");
      await requestDeployment(tx, { githubRepoId: 99, sha, prNumber: pr, mergedAt: new Date() });
    });
    await tick();
    const [row] = await deploymentsOf(sha);
    expect(row).toMatchObject({ status: "blocked", reason: "CI rouge : ci" });
  });
});
