import { sql, tasks, webhookRedeliveries } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { FakeGitHub } from "@jules/forge/testing";
import { buildGateway } from "@jules/gateway/app";
import { createServer } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileDeliveries } from "../src/reconcile.js";
import { AppSetupError, Worker } from "../src/worker.js";
import { issueComment, repo } from "./fixtures.js";
import { eventually, testDeps } from "./harness.js";

// Definition of Done de M0 (ROADMAP.md) : gateway HTTP réel, worker réel, base réelle,
// GitHub simulé qui livre de vrais webhooks signés.

const secret = "secret-de-webhook-de-bout-en-bout";
let t: TestDatabase;
let port: number;
let gateway: ReturnType<typeof buildGateway> | undefined;
let worker: Worker | undefined;
let github: FakeGitHub;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: p } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return p;
}

async function startGateway() {
  gateway = buildGateway({ db: t.db, webhookSecret: secret });
  await gateway.listen({ host: "127.0.0.1", port });
}

async function startWorker() {
  // Scrutation très lente : seul LISTEN/NOTIFY peut réveiller le worker pendant le test.
  worker = new Worker(testDeps(t.db, github), { databaseUrl: t.url, pollMs: 60_000 });
  await worker.start();
}

const statusComments = () => {
  const comments = github.commentsOn(repo, 1);
  return Promise.resolve(comments.length > 0 ? comments : undefined);
};

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.db.execute(
    sql`truncate tasks, outbox, events, users, repos, installations, webhook_redeliveries cascade`,
  );
  port = await freePort();
  github = new FakeGitHub({ url: `http://127.0.0.1:${port}/webhooks/github`, secret });
  github.setRole("alice", "write");
});
afterEach(async () => {
  await worker?.stop();
  await gateway?.close();
  worker = undefined;
  gateway = undefined;
});

describe("M0 de bout en bout", () => {
  it("un commentaire @jules crée une tâche et Jules répond par un commentaire de statut", async () => {
    await startGateway();
    await startWorker();

    const delivery = await github.deliver(
      "issue_comment",
      issueComment({ body: "@jules ajoute /healthz" }),
    );

    expect(delivery.statusCode).toBe(202);
    const comments = await eventually(statusComments);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("`reçue`");
    expect(await t.db.select().from(tasks)).toHaveLength(1);
  });

  it("un @jules envoyé pendant que le gateway est arrêté est rattrapé au redémarrage", async () => {
    const lost = await github.deliver(
      "issue_comment",
      issueComment({ body: "@jules pendant la panne" }),
    );
    expect(lost.statusCode).toBe(502);

    await startGateway();
    await startWorker(); // la réconciliation de démarrage redemande la livraison à GitHub

    const comments = await eventually(statusComments);
    expect(comments).toHaveLength(1);
    const [task] = await t.db.select().from(tasks);
    expect(task?.request).toBe("@jules pendant la panne");
    expect(github.deliveries[0]).toMatchObject({
      guid: lost.guid,
      redelivery: true,
      statusCode: 202,
    });
  });
});

describe("réconciliation des webhooks", () => {
  const deps = () => testDeps(t.db, github);
  const at = (deliveredAt: number, offsetMs: number) => new Date(deliveredAt + offsetMs);

  it("ne redemande pas une livraison déjà reçue", async () => {
    await startGateway();
    await github.deliver("issue_comment", issueComment({ body: "@jules" }));

    const report = await reconcileDeliveries(deps(), { lookbackMs: 3600_000, graceMs: 0 });

    expect(report).toEqual({ scanned: 1, missing: 0, redelivered: 0, gaveUp: 0 });
  });

  it("rattrape une livraison réussie qui n'est plus en base, après un délai de grâce", async () => {
    // Cas d'une restauration : GitHub a bien livré, mais la base restaurée ne l'a plus.
    await startGateway();
    const delivered = await github.deliver("issue_comment", issueComment({ body: "@jules" }));
    await t.db.execute(sql`truncate events cascade`);
    const options = { lookbackMs: 3600_000, graceMs: 60_000 };
    const base = delivered.deliveredAt.getTime();

    expect(
      (await reconcileDeliveries(deps(), { ...options, now: at(base, 1_000) })).redelivered,
    ).toBe(0);
    expect(
      (await reconcileDeliveries(deps(), { ...options, now: at(base, 61_000) })).redelivered,
    ).toBe(1);
    expect(github.deliveries[0]).toMatchObject({
      guid: delivered.guid,
      redelivery: true,
      statusCode: 202,
    });
  });

  it("espace les relivraisons, puis abandonne après le nombre maximal de tentatives", async () => {
    const lost = await github.deliver("issue_comment", issueComment({ body: "@jules" }));
    const base = lost.deliveredAt.getTime();
    const options = {
      lookbackMs: 3 * 24 * 3600_000,
      graceMs: 0,
      retryAfterMs: 600_000,
      maxAttempts: 2,
    };

    // Le gateway reste arrêté : chaque relivraison échoue aussi.
    expect(
      (await reconcileDeliveries(deps(), { ...options, now: at(base, 1_000) })).redelivered,
    ).toBe(1);
    expect(
      (await reconcileDeliveries(deps(), { ...options, now: at(base, 2_000) })).redelivered,
    ).toBe(0);
    expect(
      (await reconcileDeliveries(deps(), { ...options, now: at(base, 700_000) })).redelivered,
    ).toBe(1);
    const last = await reconcileDeliveries(deps(), { ...options, now: at(base, 1_400_000) });

    expect(last).toMatchObject({ redelivered: 0, gaveUp: 1 });
    const [row] = await t.db.select().from(webhookRedeliveries);
    expect(row).toMatchObject({ deliveryGuid: lost.guid, attempts: 2 });
  });

  it("ignore l'historique plus ancien que la fenêtre demandée", async () => {
    const lost = await github.deliver("issue_comment", issueComment({ body: "@jules" }));

    const report = await reconcileDeliveries(deps(), {
      lookbackMs: 3600_000,
      graceMs: 0,
      now: at(lost.deliveredAt.getTime(), 2 * 3600_000),
    });

    expect(report).toEqual({ scanned: 0, missing: 0, redelivered: 0, gaveUp: 0 });
  });

  it("refuse de démarrer si la GitHub App a la permission workflows", async () => {
    github.app = { ...github.app, permissions: { ...github.app.permissions, workflows: "write" } };
    const w = new Worker(testDeps(t.db, github), { databaseUrl: t.url });

    await expect(w.start()).rejects.toThrow(AppSetupError);
    await expect(w.start()).rejects.toThrow(/workflows:write/);
  });

  it("n'empêche pas le démarrage du worker quand GitHub est injoignable", async () => {
    await startGateway();
    github.failNext("listDeliveries");

    await startWorker();
    await github.deliver("issue_comment", issueComment({ body: "@jules" }));

    expect(await eventually(statusComments)).toHaveLength(1);
  });
});
