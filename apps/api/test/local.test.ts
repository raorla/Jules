import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { DEFAULT_ORG_ID, and, eq, outbox, registerLocalRepo, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "../src/app.js";
import { allowedLocalPath, verifyStepUpSignature } from "../src/local-routes.js";

// Mode local (M10) : l'api du desktop, sans GitHub. Connexion par le secret du trousseau, dossiers
// git comme repos, merge demandé par le bouton de l'app et exécuté par le worker.

const SECRET = randomBytes(32).toString("base64url");
// Clé de confirmation du trousseau : celle du vecteur 1 de la RFC 8032, comme dans le shell
// (apps/desktop/core/src/stepup.rs), pour vérifier ici ce que le shell signe.
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const STEP_UP_PUBLIC = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const shellKey = createPrivateKey({
  key: { kty: "OKP", crv: "Ed25519", d: SEED.toString("base64url"), x: STEP_UP_PUBLIC },
  format: "jwk",
});
/** Ce que fait le shell après le clic dans sa fenêtre native. */
const shellSign = (challenge: string, key = shellKey) =>
  sign(null, Buffer.from(`jules:local-step-up:${challenge}`), key).toString("base64url");
let t: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  t = await startTestDatabase();
  app = await buildApi({
    db: t.db,
    pool: t.pool,
    publicUrl: "http://127.0.0.1:3001",
    adminLogins: [],
    local: {
      loginHash: createHash("sha256").update(SECRET).digest("base64url"),
      roots: ["/home/ada/projets"],
      stepUpPublicKey: STEP_UP_PUBLIC,
    },
  });
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

async function localLogin(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/local",
    payload: { secret: SECRET, login: "ada" },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

const as = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

describe("mode local : connexion", () => {
  it("le secret du trousseau ouvre une session desktop admin ; un autre secret est refusé", async () => {
    expect((await app.inject({ url: "/v1/health" })).json()).toMatchObject({
      mode: "local",
      stepUp: "keychain",
    });
    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/local",
      payload: { secret: randomBytes(32).toString("base64url") },
    });
    expect(bad.statusCode).toBe(401);
    // Pas de GitHub OAuth en mode local.
    expect((await app.inject({ url: "/v1/auth/github" })).statusCode).toBe(404);

    const token = await localLogin();
    expect(token).toMatch(/^jds_/);
    const me = await as(token, "GET", "/v1/me");
    expect(me.json()).toMatchObject({ login: "ada", role: "admin" });
    // Une deuxième connexion retrouve la même personne.
    const again = await as(await localLogin(), "GET", "/v1/me");
    expect(again.json<{ userId: string }>().userId).toBe(me.json<{ userId: string }>().userId);
  });
});

describe("mode local : dossiers", () => {
  it("n'accepte qu'un chemin absolu sous les dossiers autorisés", async () => {
    expect(allowedLocalPath("/home/ada/projets/app", ["/home/ada/projets"])).toBe(
      "/home/ada/projets/app",
    );
    expect(allowedLocalPath("/home/ada/projets/app/", [])).toBe("/home/ada/projets/app");
    expect(allowedLocalPath("relatif/app", [])).toBeUndefined();
    expect(allowedLocalPath("/home/ada/projets/../.ssh", ["/home/ada/projets"])).toBeUndefined();
    expect(allowedLocalPath("/home/ada/projets-bis/x", ["/home/ada/projets"])).toBeUndefined();
    expect(allowedLocalPath("/etc", ["/home/ada/projets"])).toBeUndefined();

    const token = await localLogin();
    const refused = await as(token, "POST", "/v1/local/repos", { path: "/etc" });
    expect(refused.statusCode).toBe(400);
    const created = await as(token, "POST", "/v1/local/repos", {
      path: "/home/ada/projets/app",
      defaultBranch: "main",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ fullName: "local/app" });
    const list = await as(token, "GET", "/v1/local/repos");
    expect(list.json()).toEqual([
      expect.objectContaining({ fullName: "local/app", path: "/home/ada/projets/app" }),
    ]);
  });
});

describe("mode local : merge par le bouton", () => {
  it("demande le merge au worker, une seule fois, et seulement quand la tâche attend la review", async () => {
    const token = await localLogin();
    const repo = await registerLocalRepo(t.db, {
      orgId: DEFAULT_ORG_ID,
      path: "/home/ada/projets/merge",
    });
    const [task] = await t.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId: repo.id,
        agent: "developer",
        title: "Ajoute mul",
        request: "mul",
        issueNumber: 1,
        prNumber: 2,
        state: "reviewing",
      })
      .returning();
    const url = `/v1/tasks/${task!.id}/merge`;
    expect((await as(token, "POST", url)).statusCode).toBe(409);
    await t.db.update(tasks).set({ state: "awaiting_human_review" }).where(eq(tasks.id, task!.id));
    expect((await as(token, "GET", url)).json()).toEqual({ status: "none" });

    const first = await as(token, "POST", url);
    const second = await as(token, "POST", url);
    expect(first.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    const effects = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.kind, "local.merge"), eq(outbox.serialKey, `task:${task!.id}`)));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.payload).toMatchObject({ taskId: task!.id });
    expect((await as(token, "GET", url)).json()).toMatchObject({ status: "pending" });

    // Refus du worker (dossier modifié) : l'état le dit, et un nouveau clic relance.
    await t.db
      .update(outbox)
      .set({
        status: "done",
        result: { operation: "refused", reason: "modifications non commitées" },
      })
      .where(eq(outbox.id, effects[0]!.id));
    expect((await as(token, "GET", url)).json()).toMatchObject({
      status: "refused",
      reason: "modifications non commitées",
    });
    expect((await as(token, "POST", url)).json<{ requestId: string }>().requestId).not.toBe(
      effects[0]!.id,
    );
  });

  it("refuse le merge d'une tâche GitHub", async () => {
    const token = await localLogin();
    const [task] = await t.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId: (
          await registerLocalRepo(t.db, {
            orgId: DEFAULT_ORG_ID,
            path: "/home/ada/projets/sans-pr",
          })
        ).id,
        agent: "developer",
        title: "x",
        request: "x",
        state: "awaiting_human_review",
      })
      .returning();
    expect((await as(token, "POST", `/v1/tasks/${task!.id}/merge`)).statusCode).toBe(409);
  });
});

describe("mode local : confirmation des actions sensibles par le trousseau", () => {
  it("vérifie la signature produite par le shell (même vecteur que le cœur Rust)", () => {
    const challenge = "defi-de-test-0123456789abcdefghijklmnop";
    const fromRust =
      "NKjwF_f_4_ldDTp6fYJ2FbDiTKPdEenirp-MT6jWzCbXk8qCI2_xPAvPcNCB-w98nocM5gr7-Bv1Mw27f0e-Aw";
    expect(shellSign(challenge)).toBe(fromRust);
    expect(verifyStepUpSignature(STEP_UP_PUBLIC, challenge, fromRust)).toBe(true);
    expect(verifyStepUpSignature(STEP_UP_PUBLIC, `${challenge}x`, fromRust)).toBe(false);
    expect(verifyStepUpSignature(STEP_UP_PUBLIC, challenge, "court")).toBe(false);
    expect(verifyStepUpSignature("pas-une-cle", challenge, fromRust)).toBe(false);
  });

  it("relève l'autonomie après un défi signé par la clé du trousseau, une seule fois", async () => {
    const token = await localLogin();
    const repo = await registerLocalRepo(t.db, {
      orgId: DEFAULT_ORG_ID,
      path: "/home/ada/projets/autonomie",
    });
    const raise = () =>
      app.inject({
        method: "PATCH",
        url: `/v1/repos/${repo.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { autonomy: "L1" },
      });
    expect((await raise()).json()).toMatchObject({ stepUp: true });
    const challenge = async () =>
      (
        await as(token, "POST", "/v1/auth/local/step-up/challenge", {
          purpose: "Relever l'autonomie",
        })
      ).json<{ challenge: string }>().challenge;
    const confirm = (signature: string) =>
      as(token, "POST", "/v1/auth/local/step-up", { signature });

    // Signée par une autre clé que celle du trousseau : refusée, et le défi est brûlé.
    const other = createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        d: randomBytes(32).toString("base64url"),
        x: STEP_UP_PUBLIC,
      },
      format: "jwk",
    });
    const first = await challenge();
    expect((await confirm(shellSign(first, other))).statusCode).toBe(403);
    expect((await confirm(shellSign(first))).statusCode).toBe(403);
    expect((await raise()).json()).toMatchObject({ stepUp: true });

    const second = await challenge();
    const confirmed = await confirm(shellSign(second));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ stepUpUntil: string }>().stepUpUntil).toBeTruthy();
    expect((await raise()).statusCode).toBe(200);
    // Rejouée, la même signature ne vaut plus rien.
    expect((await confirm(shellSign(second))).statusCode).toBe(403);
  });
});
