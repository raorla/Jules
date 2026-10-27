import { appendAudit } from "@jules/audit";
import {
  ENVIRONMENTS,
  SERVER_LEVELS,
  and,
  asc,
  changePlans,
  commands,
  deployments,
  desc,
  eq,
  inArray,
  orgs,
  planSteps,
  repos,
  secretSubmissions,
  serverCommands,
  servers,
  sql,
  workerKeys,
  type Db,
} from "@jules/db";
import { computeDora } from "@jules/metrics";
import type { FastifyInstance, FastifyReply } from "fastify";
import sodium from "libsodium-wrappers";
import { z } from "zod";
import { guard, sessionOf, type Session } from "./session.js";

// Routes DevOps (M7, ARCHITECTURE.md §9) : serveurs, plans de changement, déploiements, réglages.
// L'api ne se connecte à aucun serveur et ne garde aucune clé : la clé SSH est scellée pour le
// worker dès réception, et toute décision devient une commande que le worker revérifie.

const LEVEL_ORDER = ["D0", "D1", "D2", "D3"] as const;
const hasStepUp = (session: Session) =>
  session.stepUpUntil !== null && session.stepUpUntil > new Date();
const needStepUp = (reply: FastifyReply, error: string) =>
  reply.code(403).send({ error, stepUp: true });

/** Nom du secret de la clé d'un serveur : le même que côté worker (`sshKeyName`). */
const sshKeyName = (serverId: string) => `ssh_key_${serverId.replaceAll("-", "")}`;

const serverView = (s: typeof servers.$inferSelect, repo: string | null) => ({
  id: s.id,
  name: s.name,
  host: s.host,
  port: s.port,
  username: s.username,
  environment: s.environment,
  level: s.level,
  repo,
  repoId: s.repoId,
  hostKeyStatus: s.hostKeyStatus,
  hostKeyFingerprint: s.hostKeyFingerprint,
  offeredFingerprint: s.offeredFingerprint,
  offeredAlgorithm: s.offeredAlgorithm,
  frozen: s.frozen,
  locked: s.lockPlanId !== null && s.lockUntil !== null && s.lockUntil > new Date(),
  createdAt: s.createdAt,
});

export function registerDevopsRoutes(
  app: FastifyInstance,
  options: { db: Db; publicOrigin: string },
) {
  const { db } = options;
  const g = (role: "admin" | "maintainer" | "member" | "viewer", stepUp = false) =>
    guard({ db, publicOrigin: options.publicOrigin }, role, { stepUp });

  app.get("/v1/servers", { preHandler: g("viewer") }, async () => {
    const rows = await db
      .select({ server: servers, repo: repos.fullName })
      .from(servers)
      .leftJoin(repos, eq(repos.id, servers.repoId))
      .orderBy(asc(servers.environment), asc(servers.name));
    return rows.map((r) => serverView(r.server, r.repo));
  });

  // Enregistrement d'un serveur (admin, passkey) : la clé privée est scellée pour le worker, qui lit
  // ensuite la clé d'hôte ; un admin la compare à celle du serveur avant de la valider.
  app.post<{ Body: unknown }>(
    "/v1/servers",
    { preHandler: g("admin", true) },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z
        .object({
          name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/),
          host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:]+\]?$/),
          port: z.number().int().min(1).max(65_535).default(22),
          username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
          environment: z.enum(ENVIRONMENTS),
          repoId: z.uuid().optional(),
          privateKey: z
            .string()
            .min(64)
            .max(16_000)
            .regex(/-----BEGIN [A-Z ]*PRIVATE KEY-----/),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "serveur invalide : nom, hôte, utilisateur ou clé" });
      }
      const [key] = await db.select().from(workerKeys).orderBy(desc(workerKeys.createdAt)).limit(1);
      if (!key) {
        return reply.code(503).send({ error: "le worker n'a pas encore publié sa clé" });
      }
      await sodium.ready;
      const sealed = sodium.crypto_box_seal(
        sodium.from_string(body.data.privateKey),
        sodium.from_base64(key.publicKey, sodium.base64_variants.ORIGINAL),
      );
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(servers)
          .values({
            orgId: session.orgId,
            name: body.data.name,
            host: body.data.host,
            port: body.data.port,
            username: body.data.username,
            environment: body.data.environment,
            repoId: body.data.repoId ?? null,
            createdBy: session.userId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          return undefined;
        }
        await tx.insert(secretSubmissions).values({
          orgId: session.orgId,
          name: sshKeyName(row.id),
          sealed: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
          workerKeyId: key.id,
          submittedBy: session.userId,
        });
        await appendAudit(tx, {
          orgId: session.orgId,
          actor: { type: "user", id: session.userId },
          action: "server.registered",
          target: { type: "server", id: row.id },
          data: { environment: row.environment },
        });
        return row;
      });
      if (!created) {
        return reply.code(409).send({ error: "un serveur porte déjà ce nom" });
      }
      return reply.code(201).send(serverView(created, null));
    },
  );

  // Validation de la clé d'hôte (admin, passkey) : l'empreinte saisie doit être celle offerte.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/v1/servers/:id/trust",
    { preHandler: g("admin", true) },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z
        .object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) })
        .safeParse(request.body);
      const id = z.uuid().safeParse(request.params.id);
      if (!body.success || !id.success) {
        return reply.code(400).send({ error: "empreinte invalide (format SHA256:…)" });
      }
      const [server] = await db.select().from(servers).where(eq(servers.id, id.data));
      if (!server) {
        return reply.code(404).send({ error: "serveur introuvable" });
      }
      if (server.offeredFingerprint !== body.data.fingerprint) {
        return reply
          .code(409)
          .send({ error: "l'empreinte ne correspond pas à celle offerte par le serveur" });
      }
      await db
        .update(servers)
        .set({
          hostKeyStatus: "trusted",
          hostKeyFingerprint: body.data.fingerprint,
          updatedAt: sql`now()`,
        })
        .where(eq(servers.id, server.id));
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "server.host_key_trusted",
        target: { type: "server", id: server.id },
        data: { fingerprint: body.data.fingerprint, previous: server.hostKeyFingerprint },
      });
      return { ok: true };
    },
  );

  // Niveau D et gel (admin). Relever le niveau ou dégeler exige une passkey.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/v1/servers/:id",
    { preHandler: g("admin") },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z
        .object({ level: z.enum(SERVER_LEVELS).optional(), frozen: z.boolean().optional() })
        .safeParse(request.body);
      const id = z.uuid().safeParse(request.params.id);
      if (!body.success || !id.success) {
        return reply.code(400).send({ error: "réglage invalide" });
      }
      const [server] = await db.select().from(servers).where(eq(servers.id, id.data));
      if (!server) {
        return reply.code(404).send({ error: "serveur introuvable" });
      }
      const raising =
        body.data.level !== undefined &&
        LEVEL_ORDER.indexOf(body.data.level) > LEVEL_ORDER.indexOf(server.level);
      const unfreezing = body.data.frozen === false && server.frozen;
      if ((raising || unfreezing) && !hasStepUp(session)) {
        return needStepUp(reply, "passkey requise pour relever le niveau ou dégeler");
      }
      await db
        .update(servers)
        .set({ ...body.data, updatedAt: sql`now()` })
        .where(eq(servers.id, server.id));
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "server.updated",
        target: { type: "server", id: server.id },
        data: { from: { level: server.level, frozen: server.frozen }, to: body.data },
      });
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/servers/:id/commands",
    { preHandler: g("viewer") },
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "identifiant invalide" });
      }
      return db
        .select()
        .from(serverCommands)
        .where(eq(serverCommands.serverId, id.data))
        .orderBy(desc(serverCommands.createdAt))
        .limit(200);
    },
  );

  const planView = async (status?: string[]) => {
    const rows = await db
      .select({ plan: changePlans, server: servers.name })
      .from(changePlans)
      .innerJoin(servers, eq(servers.id, changePlans.serverId))
      .where(status ? inArray(changePlans.status, status as never[]) : undefined)
      .orderBy(desc(changePlans.createdAt))
      .limit(100);
    return rows.map(({ plan, server }) => ({
      id: plan.id,
      taskId: plan.taskId,
      deploymentId: plan.deploymentId,
      server,
      environment: plan.environment,
      status: plan.status,
      plan: plan.plan,
      approvalSource: plan.approvalSource,
      failureReason: plan.failureReason,
      expiresAt: plan.expiresAt,
      createdAt: plan.createdAt,
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
    }));
  };

  app.get<{ Querystring: { status?: string } }>(
    "/v1/plans",
    { preHandler: g("viewer") },
    async (request) => planView(request.query.status ? request.query.status.split(",") : undefined),
  );

  app.get<{ Params: { id: string } }>(
    "/v1/plans/:id",
    { preHandler: g("viewer") },
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "identifiant invalide" });
      }
      const [row] = (await planView()).filter((p) => p.id === id.data);
      if (!row) {
        return reply.code(404).send({ error: "plan introuvable" });
      }
      const steps = await db
        .select()
        .from(planSteps)
        .where(eq(planSteps.planId, id.data))
        .orderBy(asc(planSteps.position));
      return { ...row, steps };
    },
  );

  // Décision sur un plan (HC1) : une commande en attente, revérifiée et appliquée par le worker.
  // La production exige une passkey au moment de la décision.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/v1/plans/:id/decision",
    { preHandler: g("member") },
    async (request, reply) => {
      const session = sessionOf(request);
      const id = z.uuid().safeParse(request.params.id);
      const body = z.object({ decision: z.enum(["approve", "reject"]) }).safeParse(request.body);
      if (!id.success || !body.success) {
        return reply.code(400).send({ error: "décision invalide" });
      }
      const [plan] = await db.select().from(changePlans).where(eq(changePlans.id, id.data));
      if (!plan) {
        return reply.code(404).send({ error: "plan introuvable" });
      }
      if (plan.status !== "pending_approval") {
        return reply.code(409).send({ error: `le plan est déjà ${plan.status}` });
      }
      const stepUp = hasStepUp(session);
      if (body.data.decision === "approve" && plan.environment === "production" && !stepUp) {
        return needStepUp(reply, "passkey requise pour approuver la production");
      }
      const name = body.data.decision === "approve" ? "approve" : "cancel";
      const [row] = await db
        .insert(commands)
        .values({
          orgId: session.orgId,
          taskId: plan.taskId,
          source: session.kind,
          authorId: session.userId,
          name,
          args: { name, planId: plan.id, stepUp },
          decision: "pending",
          reason: "en attente du worker",
        })
        .returning({ id: commands.id });
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "command.submitted",
        target: { type: "plan", id: plan.id },
        data: { command: name, source: session.kind, stepUp },
      });
      return reply.code(202).send({ commandId: row?.id });
    },
  );

  app.get("/v1/deployments", { preHandler: g("viewer") }, async () => {
    const rows = await db
      .select({ deployment: deployments, repo: repos.fullName, server: servers.name })
      .from(deployments)
      .innerJoin(repos, eq(repos.id, deployments.repoId))
      .innerJoin(servers, eq(servers.id, deployments.serverId))
      .orderBy(desc(deployments.createdAt))
      .limit(100);
    return rows.map(({ deployment: d, repo, server }) => ({
      id: d.id,
      repo,
      server,
      environment: d.environment,
      ref: d.ref,
      previousRef: d.previousRef,
      status: d.status,
      playbook: d.playbook,
      planId: d.planId,
      pullRequests: d.pullRequests,
      reason: d.reason,
      createdAt: d.createdAt,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
    }));
  });

  app.get<{ Querystring: { days?: string } }>(
    "/v1/dora",
    { preHandler: g("viewer") },
    async (request) => {
      const days = Math.min(Math.max(Number(request.query.days ?? 30) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await db
        .select()
        .from(deployments)
        .where(sql`${deployments.createdAt} >= ${since}`);
      const plans = await db
        .select({ createdAt: changePlans.createdAt })
        .from(changePlans)
        .where(
          and(
            sql`${changePlans.createdAt} >= ${since}`,
            sql`${changePlans.approvalSource} is distinct from 'auto'`,
          ),
        );
      return computeDora(rows, plans, days);
    },
  );

  app.get("/v1/settings/org", { preHandler: g("admin") }, async (request) => {
    const session = sessionOf(request);
    const [org] = await db.select().from(orgs).where(eq(orgs.id, session.orgId));
    return {
      fourEyes: org?.fourEyes ?? false,
      githubProductionApproval: org?.githubProductionApproval ?? false,
    };
  });

  // Ces réglages relâchent ou durcissent l'approbation de la production : passkey exigée.
  app.patch<{ Body: unknown }>(
    "/v1/settings/org",
    { preHandler: g("admin", true) },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z
        .object({
          fourEyes: z.boolean().optional(),
          githubProductionApproval: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "réglage invalide" });
      }
      await db.update(orgs).set(body.data).where(eq(orgs.id, session.orgId));
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "org.settings",
        target: { type: "org", id: session.orgId },
        data: body.data,
      });
      return { ok: true };
    },
  );
}
