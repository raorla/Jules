import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_ORG_ID,
  changePlans,
  commands,
  eq,
  installations,
  memberships,
  repos,
  runs,
  secretSubmissions,
  servers,
  stops,
  tasks,
  toolCalls,
  users,
  workerKeys,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import type { FastifyInstance } from "fastify";
import sodium from "libsodium-wrappers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSP, buildApi } from "../src/app.js";
import { SoftAuthenticator } from "./authenticator.js";

const PUBLIC_URL = "https://jules.test";
let t: TestDatabase;
let app: FastifyInstance;
let github: Server;
let workerPrivateKey: Uint8Array;

beforeAll(async () => {
  t = await startTestDatabase();
  // Faux GitHub OAuth : le code est le login de la personne qui se connecte.
  github = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/login/oauth/access_token")) {
        const { code } = JSON.parse(body) as { code: string };
        res.end(
          JSON.stringify(
            code === "refuse"
              ? { error: "bad_verification_code" }
              : { access_token: `gho_${code}` },
          ),
        );
      } else if (req.url === "/user") {
        const login = (req.headers.authorization ?? "").replace("Bearer gho_", "");
        // Identifiant stable et propre à chaque login (comme sur GitHub).
        res.end(
          JSON.stringify({
            id: Array.from({ length: login.length }, (_, i) => login.charCodeAt(i)).reduce(
              (h, c) => (h * 31 + c) % 1_000_000_007,
              7,
            ),
            login,
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  app = await buildApi({
    db: t.db,
    pool: t.pool,
    publicUrl: PUBLIC_URL,
    oauth: { clientId: "c", clientSecret: "s", webBase: base, apiBase: base },
    adminLogins: ["root"],
  });
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  workerPrivateKey = pair.privateKey;
  await t.db.insert(workerKeys).values({
    orgId: DEFAULT_ORG_ID,
    publicKey: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
  });
});
afterAll(async () => {
  await app.close();
  github.close();
  await t.stop();
});

type Agent = { cookie: string; csrf: string; userId: string };

async function login(code: string): Promise<Agent | undefined> {
  const start = await app.inject({ url: "/v1/auth/github" });
  const location = new URL(start.headers.location as string);
  const state = location.searchParams.get("state") ?? "";
  const stateCookie = start.cookies.find((c) => c.name === "jules_oauth_state")?.value ?? "";
  const callback = await app.inject({
    url: `/v1/auth/github/callback?code=${code}&state=${state}`,
    cookies: { jules_oauth_state: stateCookie },
  });
  const session = callback.cookies.find((c) => c.name === "jules_session");
  if (!session) {
    return undefined;
  }
  const me = await app.inject({ url: "/v1/me", cookies: { jules_session: session.value } });
  const body = me.json<{ csrfToken: string; userId: string }>();
  return { cookie: session.value, csrf: body.csrfToken, userId: body.userId };
}

const call = (
  agent: Agent,
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    cookies: { jules_session: agent.cookie },
    headers: { "x-jules-csrf": agent.csrf, origin: PUBLIC_URL, ...headers },
    ...(payload ? { payload } : {}),
  });

async function seedRepoAndTask() {
  const [installation] = await t.db
    .insert(installations)
    .values({
      orgId: DEFAULT_ORG_ID,
      githubInstallationId: Math.floor(Math.random() * 1e9),
      accountLogin: "acme",
      accountType: "Organization",
    })
    .returning();
  const [repo] = await t.db
    .insert(repos)
    .values({
      orgId: DEFAULT_ORG_ID,
      forge: "github",
      installationId: installation!.id,
      githubRepoId: Math.floor(Math.random() * 1e9),
      fullName: "acme/app",
      defaultBranch: "main",
      private: true,
      autonomy: "L1",
    })
    .returning();
  const [task] = await t.db
    .insert(tasks)
    .values({
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      agent: "developer",
      issueNumber: Math.floor(Math.random() * 1e6),
      title: "t",
      request: "r",
      state: "awaiting_spec_approval",
      risk: "medium",
    })
    .returning();
  return { repo: repo!, task: task! };
}

async function addMember(login: string, role: "admin" | "maintainer" | "member" | "viewer") {
  const [user] = await t.db
    .insert(users)
    .values({ orgId: DEFAULT_ORG_ID, login, kind: "human" })
    .returning();
  await t.db.insert(memberships).values({ orgId: DEFAULT_ORG_ID, userId: user!.id, role });
}

describe("connexion", () => {
  it("connecte un admin listé et refuse un compte qui n'est pas membre", async () => {
    expect(await login("root")).toBeDefined();
    expect(await login("inconnu")).toBeUndefined();
    const refused = await app.inject({
      url: "/v1/auth/github/callback?code=root&state=forge",
      cookies: { jules_oauth_state: "autre" },
    });
    expect(refused.statusCode).toBe(400);
  });

  it("pose un cookie HttpOnly, SameSite=Strict, et une CSP stricte", async () => {
    const start = await app.inject({ url: "/v1/auth/github" });
    const state = new URL(start.headers.location as string).searchParams.get("state") ?? "";
    const callback = await app.inject({
      url: `/v1/auth/github/callback?code=root&state=${state}`,
      cookies: { jules_oauth_state: start.cookies[0]?.value ?? "" },
    });
    const cookie = callback.cookies.find((c) => c.name === "jules_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", secure: true });
    expect(callback.headers["content-security-policy"]).toBe(CSP);
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toContain("unsafe-inline");
  });
});

describe("CSRF (DoD M6)", () => {
  it("refuse une écriture sans jeton CSRF, avec un faux jeton ou depuis une autre origine", async () => {
    const admin = (await login("root"))!;
    const { task } = await seedRepoAndTask();
    const url = `/v1/tasks/${task.id}/commands`;
    expect(
      (await call(admin, "POST", url, { name: "approve" }, { "x-jules-csrf": "" })).statusCode,
    ).toBe(403);
    expect(
      (await call(admin, "POST", url, { name: "approve" }, { "x-jules-csrf": "faux" })).statusCode,
    ).toBe(403);
    expect(
      (await call(admin, "POST", url, { name: "approve" }, { origin: "https://attaquant.example" }))
        .statusCode,
    ).toBe(403);
    expect((await call(admin, "POST", url, { name: "approve" })).statusCode).toBe(202);
  });

  it("refuse une requête sans session", async () => {
    expect((await app.inject({ url: "/v1/tasks" })).statusCode).toBe(401);
  });
});

describe("rôles et commandes", () => {
  it("écrit une commande en attente pour le worker ; un viewer ne peut pas en envoyer", async () => {
    await addMember("vera", "viewer");
    const viewer = (await login("vera"))!;
    const admin = (await login("root"))!;
    const { task } = await seedRepoAndTask();

    expect(
      (await call(viewer, "POST", `/v1/tasks/${task.id}/commands`, { name: "approve" })).statusCode,
    ).toBe(403);
    const accepted = await call(admin, "POST", `/v1/tasks/${task.id}/commands`, {
      name: "approve",
    });
    const { commandId } = accepted.json<{ commandId: string }>();
    const [row] = await t.db.select().from(commands).where(eq(commands.id, commandId));
    expect(row).toMatchObject({ decision: "pending", source: "web", name: "approve" });
    expect(
      (await call(admin, "POST", `/v1/tasks/${task.id}/commands`, { name: "rm -rf" })).statusCode,
    ).toBe(400);
  });

  it("liste les tâches et le détail, les approbations en attente", async () => {
    const admin = (await login("root"))!;
    const { task } = await seedRepoAndTask();
    expect(
      (await call(admin, "GET", "/v1/tasks"))
        .json<{ id: string }[]>()
        .some((x) => x.id === task.id),
    ).toBe(true);
    expect(
      (await call(admin, "GET", `/v1/tasks/${task.id}`)).json<{ task: { id: string } }>().task.id,
    ).toBe(task.id);
    expect(
      (await call(admin, "GET", "/v1/approvals"))
        .json<{ id: string }[]>()
        .some((x) => x.id === task.id),
    ).toBe(true);
  });

  it("donne la transcription d'une exécution, telle que le worker l'a masquée", async () => {
    await addMember("lea", "viewer");
    const viewer = (await login("lea"))!;
    const { task } = await seedRepoAndTask();
    const [run] = await t.db
      .insert(runs)
      .values({
        orgId: DEFAULT_ORG_ID,
        taskId: task.id,
        role: "developer",
        model: "claude-opus-5-5",
        promptVersion: "developer/v1",
        tokenHash: `h-${task.id}`,
        tokenExpiresAt: new Date(),
        budgetUsd: "1",
      })
      .returning();
    await t.db.insert(toolCalls).values({
      orgId: DEFAULT_ORG_ID,
      runId: run!.id,
      capability: "post_update",
      input: { message: "clé [masqué]" },
      effect: "allow",
      ruleId: "role.allowed",
      reason: "autorisé",
      output: "ok",
      durationMs: 3,
    });
    const transcript = await call(viewer, "GET", `/v1/runs/${run!.id}/tool-calls`);
    expect(transcript.statusCode).toBe(200);
    expect(transcript.json()).toMatchObject([
      { capability: "post_update", effect: "allow", input: { message: "clé [masqué]" } },
    ]);
    expect((await call(viewer, "GET", "/v1/runs/pas-un-uuid/tool-calls")).statusCode).toBe(400);
  });
});

describe("secrets en écriture seule (DoD M6)", () => {
  it("scelle le secret pour le worker : l'api ne peut pas le relire", async () => {
    const admin = (await login("root"))!;
    const rp = new SoftAuthenticator("jules.test", PUBLIC_URL);
    await registerPasskey(admin, rp);
    await stepUp(admin, rp);

    expect(
      (
        await call(admin, "PUT", "/v1/secrets/ssh_app_prod", {
          value: "-----BEGIN OPENSSH PRIVATE KEY----- secret",
        })
      ).statusCode,
    ).toBe(202);

    const [submission] = await t.db
      .select()
      .from(secretSubmissions)
      .where(eq(secretSubmissions.name, "ssh_app_prod"));
    expect(submission?.sealed).not.toContain("secret");
    const listed = await call(admin, "GET", "/v1/secrets");
    expect(JSON.stringify(listed.json())).not.toContain("BEGIN OPENSSH");
    // L'api n'a que la clé publique : ouvrir le scellé sans la clé privée du worker est impossible.
    const [key] = await t.db.select().from(workerKeys);
    const sealed = sodium.from_base64(submission!.sealed, sodium.base64_variants.ORIGINAL);
    const publicKey = sodium.from_base64(key!.publicKey, sodium.base64_variants.ORIGINAL);
    expect(() =>
      sodium.crypto_box_seal_open(sealed, publicKey, sodium.crypto_box_keypair().privateKey),
    ).toThrow();
    expect(
      sodium.to_string(sodium.crypto_box_seal_open(sealed, publicKey, workerPrivateKey)),
    ).toContain("BEGIN OPENSSH");
  });
});

async function registerPasskey(agent: Agent, authenticator: SoftAuthenticator) {
  const options = (await call(agent, "POST", "/v1/passkeys/register/options", {})).json<{
    challenge: string;
  }>();
  const verified = await call(agent, "POST", "/v1/passkeys/register/verify", {
    response: authenticator.register(options.challenge),
    label: "test",
  });
  expect(verified.json()).toEqual({ ok: true });
}

async function stepUp(agent: Agent, authenticator: SoftAuthenticator) {
  const options = (await call(agent, "POST", "/v1/step-up/options", { purpose: "test" })).json<{
    challenge: string;
  }>();
  const verified = await call(agent, "POST", "/v1/step-up/verify", {
    response: authenticator.authenticate(options.challenge),
  });
  expect(verified.statusCode).toBe(200);
}

describe("passkey au moment de l'action (DoD M6)", () => {
  it("refuse une action sensible avec une session valide mais sans passkey, l'accepte après", async () => {
    await addMember("admin2", "admin");
    const admin = (await login("admin2"))!;
    const { repo } = await seedRepoAndTask();
    await t.db
      .insert(stops)
      .values({ orgId: DEFAULT_ORG_ID, scope: "global", reason: "test", setBy: "test" });

    for (const [method, url, payload] of [
      ["PUT", "/v1/secrets/github_token", { value: "x" }],
      ["POST", "/v1/stop/lift", {}],
      ["PATCH", `/v1/repos/${repo.id}`, { autonomy: "L2" }],
    ] as const) {
      const res = await call(admin, method, url, payload);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ stepUp: true });
    }
    // Baisser l'autonomie n'est pas sensible.
    expect(
      (await call(admin, "PATCH", `/v1/repos/${repo.id}`, { autonomy: "L0" })).statusCode,
    ).toBe(200);

    const authenticator = new SoftAuthenticator("jules.test", PUBLIC_URL);
    expect((await call(admin, "POST", "/v1/step-up/options", {})).statusCode).toBe(409);
    await registerPasskey(admin, authenticator);
    // Une passkey d'un autre site (mauvaise origine) est refusée.
    const forged = new SoftAuthenticator("jules.test", "https://attaquant.example");
    const opts = (await call(admin, "POST", "/v1/step-up/options", {})).json<{
      challenge: string;
    }>();
    expect(
      (
        await call(admin, "POST", "/v1/step-up/verify", {
          response: { ...forged.authenticate(opts.challenge), id: authenticator.register("x").id },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);

    await stepUp(admin, authenticator);
    expect((await call(admin, "POST", "/v1/stop/lift", {})).json()).toEqual({ lifted: 1 });
    expect(
      (await call(admin, "PATCH", `/v1/repos/${repo.id}`, { autonomy: "L2" })).statusCode,
    ).toBe(200);
  });
});

describe("arrêt d'urgence", () => {
  it("bloque tout de suite en base et demande au worker de tuer les sandboxes", async () => {
    const admin = (await login("root"))!;
    expect((await call(admin, "POST", "/v1/stop", { reason: "incident" })).statusCode).toBe(200);
    const active = (await call(admin, "GET", "/v1/stop")).json<unknown[]>();
    expect(active.length).toBeGreaterThan(0);
    const pending = await t.db.select().from(commands).where(eq(commands.name, "stop_all"));
    expect(pending.at(-1)).toMatchObject({ decision: "pending" });
  });
});

describe("DevOps (M7)", () => {
  const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"b".repeat(200)}\n-----END OPENSSH PRIVATE KEY-----\n`;

  it("enregistre un serveur avec passkey : la clé est scellée pour le worker et jamais renvoyée", async () => {
    await addMember("ops-admin", "admin");
    const admin = (await login("ops-admin"))!;
    const body = {
      name: "web-1",
      host: "10.0.0.5",
      port: 22,
      username: "jules",
      environment: "staging",
      privateKey: PRIVATE_KEY,
    };
    const refused = await call(admin, "POST", "/v1/servers", body);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ stepUp: true });
    const authenticator = new SoftAuthenticator("jules.test", PUBLIC_URL);
    await registerPasskey(admin, authenticator);
    await stepUp(admin, authenticator);
    const created = await call(admin, "POST", "/v1/servers", body);
    expect(created.statusCode).toBe(201);
    const server = created.json<{ id: string; hostKeyStatus: string }>();
    expect(server.hostKeyStatus).toBe("pending");
    expect(created.body).not.toContain("PRIVATE KEY");
    const [submission] = await t.db
      .select()
      .from(secretSubmissions)
      .where(eq(secretSubmissions.name, `ssh_key_${server.id.replaceAll("-", "")}`));
    expect(submission?.sealed).not.toContain("PRIVATE KEY");
    expect(JSON.stringify((await call(admin, "GET", "/v1/servers")).json())).not.toContain(
      "PRIVATE KEY",
    );
    expect((await call(admin, "POST", "/v1/servers", body)).statusCode).toBe(409);

    // La clé d'hôte : seule l'empreinte offerte par le serveur peut être validée.
    await t.db
      .update(servers)
      .set({ hostKeyStatus: "awaiting_validation", offeredFingerprint: `SHA256:${"A".repeat(43)}` })
      .where(eq(servers.id, server.id));
    const wrong = await call(admin, "POST", `/v1/servers/${server.id}/trust`, {
      fingerprint: `SHA256:${"B".repeat(43)}`,
    });
    expect(wrong.statusCode).toBe(409);
    const trusted = await call(admin, "POST", `/v1/servers/${server.id}/trust`, {
      fingerprint: `SHA256:${"A".repeat(43)}`,
    });
    expect(trusted.statusCode).toBe(200);
    const [row] = await t.db.select().from(servers).where(eq(servers.id, server.id));
    expect(row).toMatchObject({
      hostKeyStatus: "trusted",
      hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    });
  });

  it("exige une passkey pour approuver un plan de production, pas pour la staging", async () => {
    await addMember("ops-maint", "maintainer");
    const maintainer = (await login("ops-maint"))!;
    const { repo } = await seedRepoAndTask();
    const plan = async (environment: "staging" | "production") => {
      const [server] = await t.db
        .insert(servers)
        .values({
          orgId: DEFAULT_ORG_ID,
          name: `srv-${crypto.randomUUID().slice(0, 6)}`,
          host: "h",
          username: "jules",
          environment,
          repoId: repo.id,
        })
        .returning();
      const [row] = await t.db
        .insert(changePlans)
        .values({
          orgId: DEFAULT_ORG_ID,
          serverId: server!.id,
          plan: {},
          steps: [],
          planHash: "x",
          environment,
          status: "pending_approval",
          expiresAt: new Date(Date.now() + 600_000),
        })
        .returning();
      return row!;
    };
    const staging = await plan("staging");
    const accepted = await call(maintainer, "POST", `/v1/plans/${staging.id}/decision`, {
      decision: "approve",
    });
    expect(accepted.statusCode).toBe(202);
    const [command] = await t.db
      .select()
      .from(commands)
      .where(eq(commands.id, accepted.json<{ commandId: string }>().commandId));
    expect(command).toMatchObject({
      name: "approve",
      decision: "pending",
      args: { planId: staging.id, stepUp: false },
    });

    const production = await plan("production");
    const refused = await call(maintainer, "POST", `/v1/plans/${production.id}/decision`, {
      decision: "approve",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ stepUp: true });
    // Refuser un plan n'est pas une action sensible.
    expect(
      (
        await call(maintainer, "POST", `/v1/plans/${production.id}/decision`, {
          decision: "reject",
        })
      ).statusCode,
    ).toBe(202);
    const pending = (await call(maintainer, "GET", "/v1/plans?status=pending_approval")).json<
      { id: string }[]
    >();
    expect(pending.map((p) => p.id)).toEqual(expect.arrayContaining([staging.id, production.id]));
  });

  it("protège les réglages d'approbation de la production par une passkey", async () => {
    const admin = (await login("ops-admin"))!;
    const refused = await call(admin, "PATCH", "/v1/settings/org", {
      githubProductionApproval: true,
    });
    expect(refused.json()).toMatchObject({ stepUp: true });
    expect((await call(admin, "GET", "/v1/settings/org")).json()).toEqual({
      fourEyes: false,
      githubProductionApproval: false,
    });
    expect((await call(admin, "GET", "/v1/dora?days=30")).json()).toMatchObject({
      days: 30,
      deploymentsPerWeek: 0,
    });
  });
});
