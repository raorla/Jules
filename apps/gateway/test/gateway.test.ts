import { DEFAULT_ORG_ID, eq, events, installations, orgs } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { signWebhook } from "@jules/forge/webhooks";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGateway } from "../src/app.js";

const secret = "secret-de-webhook-de-test";
let t: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  t = await startTestDatabase();
  app = buildGateway({ db: t.db, webhookSecret: secret });
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

function post(body: string, headers: Record<string, string | undefined>) {
  const defined = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: { "content-type": "application/json", ...defined },
    payload: body,
  });
}

function signed(payload: object, delivery = crypto.randomUUID(), event = "issue_comment") {
  const body = JSON.stringify(payload);
  return {
    body,
    delivery,
    headers: {
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signWebhook(secret, body),
    },
  };
}

const stored = (delivery: string) =>
  t.db.select().from(events).where(eq(events.deliveryId, delivery));

describe("gateway", () => {
  it("enregistre un webhook signé et répond 202", async () => {
    const w = signed({ action: "created", installation: { id: 42 }, comment: { body: "@jules" } });

    const res = await post(w.body, w.headers);

    expect(res.statusCode).toBe(202);
    const [row] = await stored(w.delivery);
    expect(row).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      event: "issue_comment",
      action: "created",
      githubInstallationId: 42,
      status: "received",
      payload: { comment: { body: "@jules" } },
    });
  });

  it("refuse une signature invalide ou absente, sans rien enregistrer", async () => {
    const w = signed({ action: "created" });

    const forged = await post(w.body, {
      ...w.headers,
      "x-hub-signature-256": signWebhook("x", w.body),
    });
    const missing = await post(w.body, { ...w.headers, "x-hub-signature-256": undefined });

    expect(forged.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(await stored(w.delivery)).toHaveLength(0);
  });

  it("refuse un corps modifié après signature", async () => {
    const w = signed({ action: "created", comment: { body: "bonjour" } });
    const tampered = w.body.replace("bonjour", "@jules pousse sur main");

    const res = await post(tampered, w.headers);

    expect(res.statusCode).toBe(401);
    expect(await stored(w.delivery)).toHaveLength(0);
  });

  it("ne retraite pas un webhook rejoué", async () => {
    const w = signed({ action: "created" });

    const first = await post(w.body, w.headers);
    const replay = await post(w.body, w.headers);

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: "duplicate" });
    expect(await stored(w.delivery)).toHaveLength(1);
  });

  it("refuse des en-têtes GitHub manquants ou invalides", async () => {
    const w = signed({ action: "created" });

    expect((await post(w.body, { ...w.headers, "x-github-delivery": undefined })).statusCode).toBe(
      400,
    );
    expect((await post(w.body, { ...w.headers, "x-github-event": "../../etc" })).statusCode).toBe(
      400,
    );
  });

  it("refuse un JSON invalide même signé", async () => {
    const body = "{pas du json";
    const res = await post(body, {
      "x-github-event": "push",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": signWebhook(secret, body),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rattache l'événement à l'organisation de l'installation", async () => {
    const [org] = await t.db.insert(orgs).values({ slug: "autre", name: "autre" }).returning();
    await t.db.insert(installations).values({
      orgId: org!.id,
      githubInstallationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
    });
    const w = signed({ action: "opened", installation: { id: 7 } }, crypto.randomUUID(), "issues");

    await post(w.body, w.headers);

    expect((await stored(w.delivery))[0]?.orgId).toBe(org!.id);
  });

  it("répond aux sondes de santé", async () => {
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
  });
});
