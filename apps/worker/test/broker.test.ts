import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCapability } from "@jules/agent-runner";
import { DEFAULT_ORG_ID, artifacts, auditLog, eq, runs, stops, toolCalls } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Masker } from "../src/broker/masking.js";
import {
  credentialHeaders,
  retryAfterMs,
  type ModelCredential,
} from "../src/broker/model-proxy.js";
import { startBroker, type Broker } from "../src/broker/server.js";
import { issueRunToken } from "../src/broker/tokens.js";
import { seedTask } from "./harness.js";

const API_KEY = "sk-ant-api-cle-reelle-du-worker-0123456789";
const SUBSCRIPTION = ["sk-ant-oat01", "jeton-d-abonnement-du-worker", "0123456789"].join("-");
let t: TestDatabase;
let upstream: Server;
let upstreamUrl: string;
let upstreamMode: "stream" | "overloaded" | "limited" = "stream";
const upstreamSeen: { headers: IncomingMessage["headers"]; body: string }[] = [];

beforeAll(async () => {
  t = await startTestDatabase();
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      upstreamSeen.push({ headers: req.headers, body });
      if (upstreamMode === "limited") {
        res
          .writeHead(429, { "content-type": "application/json", "retry-after": "3600" })
          .end('{"type":"error","error":{"type":"rate_limit_error","message":"x"}}');
        return;
      }
      if (upstreamMode === "overloaded") {
        res
          .writeHead(529, { "content-type": "application/json" })
          .end('{"type":"error","error":{"type":"overloaded_error","message":"x"}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000000,"output_tokens":1,"cache_read_input_tokens":0}}}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"bonjour ${API_KEY}"}}\n\n`,
      );
      res.end(
        `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":100000}}\n\n`,
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  upstream.close();
  await t.stop();
});

let broker: Broker | undefined;
let socketPath: string;
let token: string;
let runId: string;
let taskId: string;
const budgetHits: string[] = [];
const outages: string[] = [];
const announced: { runId: string; retryAfterMs: number }[] = [];

async function startRun(
  budgetUsd = "10",
  credential: ModelCredential = { kind: "api_key", secret: API_KEY },
) {
  const { task } = await seedTask(t.db);
  taskId = task.id;
  const issued = issueRunToken();
  token = issued.token;
  const [run] = await t.db
    .insert(runs)
    .values({
      orgId: DEFAULT_ORG_ID,
      taskId,
      role: "developer",
      model: "claude-opus-5-5",
      promptVersion: "developer/v1",
      status: "running",
      tokenHash: issued.hash,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      budgetUsd,
    })
    .returning();
  runId = run!.id;
  socketPath = join(mkdtempSync(join(tmpdir(), "jules-broker-")), "broker.sock");
  broker = await startBroker(
    {
      db: t.db,
      log: pino({ level: "silent" }),
      masker: new Masker([API_KEY, credential.secret]),
      model: { upstream: upstreamUrl, credential },
      onBudgetExceeded: (id) => budgetHits.push(id),
      onProviderOutage: (id) => outages.push(id),
      onRetryAfter: (id, retryAfterMs) => announced.push({ runId: id, retryAfterMs }),
    },
    { runId, socketPath },
  );
}

beforeEach(async () => {
  upstreamMode = "stream";
  upstreamSeen.length = 0;
  budgetHits.length = 0;
  outages.length = 0;
  announced.length = 0;
  await t.db.delete(stops);
  await startRun();
});
afterEach(async () => {
  await broker?.close();
});

const call = (name: string, input: unknown, as = token) =>
  callCapability(socketPath, as, name, input);

function model(body: object, as = token): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/model/v1/messages",
        method: "POST",
        headers: {
          authorization: `Bearer ${as}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("broker : outils", () => {
  it("refuse un jeton absent, faux ou révoqué", async () => {
    expect((await call("post_update", { message: "x" }, "jrt_faux")).status).toBe(401);
    await t.db.update(runs).set({ revokedAt: new Date() }).where(eq(runs.id, runId));
    expect((await call("post_update", { message: "x" })).status).toBe(401);
  });

  it.each(["merge_pull_request", "deploy", "read_secret", "git_push"])(
    "refuse l'outil piège %s et le journalise",
    async (name) => {
      const res = await call(name, {});

      expect(res.status).toBe(403);
      expect(res.text).toMatch(/^Refusé par la politique du projet : .* Ne réessaie pas\.$/);
      const [logged] = await t.db.select().from(toolCalls).where(eq(toolCalls.runId, runId));
      expect(logged).toMatchObject({
        capability: name,
        effect: "deny",
        ruleId: "absolute.honeypot",
      });
      const audit = await t.db.select().from(auditLog).where(eq(auditLog.targetId, runId));
      expect(audit.map((a) => a.action)).toEqual(["capability.deny"]);
    },
  );

  it("refuse un outil d'un autre rôle", async () => {
    expect((await call("submit_review", {})).status).toBe(403);
  });

  it("renvoie l'erreur de validation pour que l'agent corrige", async () => {
    const res = await call("submit_build", { summary: "ok", commitMessage: "pas conventionnel" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("commitMessage");
  });

  it("enregistre la build une seule fois par exécution", async () => {
    const input = { summary: "Ajout de /healthz", commitMessage: "feat(api): ajoute /healthz" };
    expect((await call("submit_build", input)).text).toMatch(/^ok: build soumise/);
    expect((await call("submit_build", input)).status).toBe(429);
    const [build] = await t.db.select().from(artifacts).where(eq(artifacts.taskId, taskId));
    expect(build).toMatchObject({
      kind: "build",
      version: 1,
      content: { ...input, testsAdded: [] },
    });
  });

  it("limite post_update à un appel toutes les 15 s", async () => {
    expect((await call("post_update", { message: "je commence" })).status).toBe(200);
    const second = await call("post_update", { message: "encore" });
    expect(second.status).toBe(429);
    expect(second.text).toContain("15 s");
  });

  it("masque les secrets dans les entrées journalisées", async () => {
    await call("post_update", { message: `fuite ${API_KEY} et ghp_${"a".repeat(36)}` });
    const [logged] = await t.db.select().from(toolCalls).where(eq(toolCalls.runId, runId));
    expect(JSON.stringify(logged?.input)).not.toContain(API_KEY);
    expect(JSON.stringify(logged?.input)).not.toContain("ghp_");
    expect(logged?.output ?? "").not.toContain(API_KEY);
  });

  it("refuse tout pendant l'arrêt d'urgence", async () => {
    await t.db
      .insert(stops)
      .values({ orgId: DEFAULT_ORG_ID, scope: "global", reason: "test", setBy: "test" });
    const res = await call("post_update", { message: "x" });
    expect(res.status).toBe(403);
    expect(res.text).toContain("arrêt d'urgence");
    expect((await model({ model: "claude-opus-5-5" })).status).toBe(403);
  });
});

describe("broker : proxy modèle", () => {
  it("remplace le jeton d'exécution par la vraie clé et compte le coût", async () => {
    const res = await model({ model: "claude-opus-5-5", stream: true, messages: [] });

    expect(res.status).toBe(200);
    const seen = upstreamSeen[0]!;
    expect(seen.headers["x-api-key"]).toBe(API_KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(token);
    const [run] = await t.db.select().from(runs).where(eq(runs.id, runId));
    // 1 M tokens d'entrée à 4 $ + 100 000 tokens de sortie à 20 $ = 6 $
    expect(run).toMatchObject({ inputTokens: 1_000_000, outputTokens: 100_000, modelRequests: 1 });
    expect(Number(run?.costUsd)).toBeCloseTo(6, 6);
  });

  it("masque les secrets connus dans les deux sens", async () => {
    const res = await model({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: `voici ${API_KEY}` }],
    });

    expect(upstreamSeen[0]?.body).not.toContain(API_KEY);
    expect(upstreamSeen[0]?.body).toContain("[masqué]");
    expect(res.text).not.toContain(API_KEY);
  });

  it("coupe l'exécution quand le budget est atteint", async () => {
    await broker?.close();
    await startRun("5");

    await model({ model: "claude-opus-5-5", stream: true });
    expect(budgetHits).toEqual([runId]);

    const refused = await model({ model: "claude-opus-5-5", stream: true });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("budget");
    expect(upstreamSeen).toHaveLength(1);
  });

  it("abonnement Claude : le jeton part en Bearer, avec la bêta d'abonnement ajoutée une fois", async () => {
    await broker?.close();
    await startRun("10", { kind: "subscription", secret: SUBSCRIPTION });
    const res = await model({ model: "claude-opus-5-5", stream: true, messages: [] });

    expect(res.status).toBe(200);
    const seen = upstreamSeen[0]!;
    expect(seen.headers.authorization).toBe(`Bearer ${SUBSCRIPTION}`);
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(seen.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.stringify(seen.headers)).not.toContain(token);
  });

  it("une limite (429) donne la reprise annoncée par le fournisseur", async () => {
    upstreamMode = "limited";
    // Dès la première limite : Claude Code n'insiste pas sur une longue attente.
    expect((await model({ model: "claude-opus-5-5" })).status).toBe(429);
    expect(announced).toEqual([{ runId, retryAfterMs: 3600_000 }]);
    expect(outages).toEqual([]);
    for (let i = 0; i < 2; i++) {
      expect((await model({ model: "claude-opus-5-5" })).status).toBe(429);
    }
    expect(outages).toEqual([runId]);
  });

  it("compte les erreurs du fournisseur", async () => {
    upstreamMode = "overloaded";
    expect((await model({ model: "claude-opus-5-5" })).status).toBe(529);
    const [run] = await t.db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.providerErrors).toBe(1);
  });
});

describe("proxy modèle : accès et reprise", () => {
  it("clé API en x-api-key ; jeton d'abonnement en Bearer, bêtas conservées", () => {
    expect(credentialHeaders({ kind: "api_key", secret: "k" }, "a,b")).toEqual({
      "x-api-key": "k",
      "anthropic-beta": "a,b",
    });
    expect(credentialHeaders({ kind: "api_key", secret: "k" }, undefined)).toEqual({
      "x-api-key": "k",
    });
    expect(
      credentialHeaders({ kind: "subscription", secret: "t" }, "a, oauth-2025-04-20 ,b"),
    ).toEqual({ authorization: "Bearer t", "anthropic-beta": "a,b,oauth-2025-04-20" });
  });

  it("lit retry-after, sinon la fin de la fenêtre de l'abonnement, et ignore l'aberrant", () => {
    const now = 1_800_000_000_000;
    const h = (entries: Record<string, string>) => new Headers(entries);
    expect(retryAfterMs(h({ "retry-after": "120" }), now)).toBe(120_000);
    expect(
      retryAfterMs(h({ "anthropic-ratelimit-unified-reset": String(now / 1000 + 5400) }), now),
    ).toBe(5_400_000);
    expect(retryAfterMs(h({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), now)).toBe(
      undefined,
    );
    expect(retryAfterMs(h({ "retry-after": String(30 * 86_400) }), now)).toBe(undefined);
    expect(
      retryAfterMs(h({ "anthropic-ratelimit-unified-reset": String(now / 1000 - 10) }), now),
    ).toBe(undefined);
    expect(retryAfterMs(h({}), now)).toBe(undefined);
  });
});
