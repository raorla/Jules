import { appendAudit, verifyAuditChain } from "@jules/audit";
import { commandSchema, requiredRole, type JulesRole } from "@jules/commands";
import {
  CHANNELS,
  DEFAULT_ORG_ID,
  and,
  artifacts,
  asc,
  auditLog,
  changePlans,
  commands,
  desc,
  eq,
  evalRuns,
  inArray,
  isNull,
  memberships,
  outbox,
  repos,
  runs,
  secretSubmissions,
  secrets,
  sql,
  stops,
  tasks,
  toolCalls,
  users,
  workerKeys,
  type Db,
} from "@jules/db";
import { computeMetrics } from "@jules/metrics";
import type { FastifyInstance } from "fastify";
import sodium from "libsodium-wrappers";
import type pg from "pg";
import { z } from "zod";
import { guard, sessionOf } from "./session.js";

// API REST `/v1` (ARCHITECTURE.md §4.2). L'api n'a aucun secret d'exécution : une action humaine
// devient une commande en base, que le worker revérifie (droits GitHub compris) puis applique.

const APPROVAL_STATES = [
  "awaiting_spec_approval",
  "awaiting_design_approval",
  "awaiting_plan_approval",
  "awaiting_info",
] as const;

/** Rôle Jules minimal pour envoyer une commande ; le worker y ajoute la permission GitHub. */
const COMMAND_ROLE: Record<string, JulesRole> = {
  admin: "admin",
  maintain: "maintainer",
  write: "member",
};

export function registerRoutes(
  app: FastifyInstance,
  options: { db: Db; publicOrigin: string; pool: pg.Pool },
) {
  const { db } = options;
  const g = (role: JulesRole, stepUp = false) =>
    guard({ db, publicOrigin: options.publicOrigin }, role, { stepUp });

  app.get("/v1/me", { preHandler: g("viewer") }, (request) => {
    const s = sessionOf(request);
    return {
      userId: s.userId,
      login: s.login,
      role: s.role,
      csrfToken: s.csrfToken,
      stepUpUntil: s.stepUpUntil,
    };
  });

  app.post("/v1/auth/logout", { preHandler: g("viewer") }, async (request, reply) => {
    await db.execute(
      sql`update sessions set revoked_at = now() where id = ${sessionOf(request).id}`,
    );
    void reply.clearCookie("jules_session", { path: "/" });
    return { ok: true };
  });

  app.get<{ Querystring: { state?: string } }>(
    "/v1/tasks",
    { preHandler: g("viewer") },
    async (request) => {
      const rows = await db
        .select({ task: tasks, repo: repos.fullName })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .where(request.query.state ? eq(tasks.state, request.query.state as never) : undefined)
        .orderBy(desc(tasks.updatedAt))
        .limit(200);
      return rows.map(({ task, repo }) => ({
        id: task.id,
        repo,
        title: task.title,
        state: task.state,
        agent: task.agent,
        type: task.type,
        size: task.size,
        risk: task.risk,
        autonomy: task.autonomy,
        issueNumber: task.issueNumber,
        prUrl: task.prUrl,
        costUsd: Number(task.costUsd),
        budgetUsd: task.budgetUsd === null ? null : Number(task.budgetUsd),
        lastError: task.lastError,
        updatedAt: task.updatedAt,
      }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/tasks/:id",
    { preHandler: g("viewer") },
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "identifiant invalide" });
      }
      const [row] = await db
        .select({ task: tasks, repo: repos.fullName })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .where(eq(tasks.id, id.data));
      if (!row) {
        return reply.code(404).send({ error: "tâche introuvable" });
      }
      const [taskArtifacts, taskRuns, taskCommands, timeline] = await Promise.all([
        db
          .select({
            kind: artifacts.kind,
            version: artifacts.version,
            content: artifacts.content,
            model: artifacts.model,
            promptVersion: artifacts.promptVersion,
            createdAt: artifacts.createdAt,
          })
          .from(artifacts)
          .where(eq(artifacts.taskId, id.data))
          .orderBy(asc(artifacts.createdAt)),
        db
          .select({
            id: runs.id,
            role: runs.role,
            model: runs.model,
            promptVersion: runs.promptVersion,
            status: runs.status,
            costUsd: runs.costUsd,
            inputTokens: runs.inputTokens,
            outputTokens: runs.outputTokens,
            startedAt: runs.startedAt,
            endedAt: runs.endedAt,
          })
          .from(runs)
          .where(eq(runs.taskId, id.data))
          .orderBy(asc(runs.createdAt)),
        db
          .select({
            id: commands.id,
            name: commands.name,
            source: commands.source,
            decision: commands.decision,
            reason: commands.reason,
            createdAt: commands.createdAt,
            login: users.login,
          })
          .from(commands)
          .leftJoin(users, eq(users.id, commands.authorId))
          .where(eq(commands.taskId, id.data))
          .orderBy(asc(commands.createdAt)),
        db
          .select({ at: auditLog.at, action: auditLog.action, data: auditLog.data })
          .from(auditLog)
          .where(and(eq(auditLog.targetId, id.data), eq(auditLog.action, "task.transition")))
          .orderBy(asc(auditLog.seq)),
      ]);
      return {
        task: {
          ...row.task,
          repo: row.repo,
          costUsd: Number(row.task.costUsd),
          budgetUsd: row.task.budgetUsd === null ? null : Number(row.task.budgetUsd),
        },
        artifacts: taskArtifacts,
        runs: taskRuns.map((r) => ({ ...r, costUsd: Number(r.costUsd) })),
        commands: taskCommands,
        timeline,
      };
    },
  );

  // Transcription d'une exécution : les appels d'outils, masqués par le worker à l'écriture.
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/tool-calls",
    { preHandler: g("viewer") },
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "identifiant invalide" });
      }
      return db
        .select({
          id: toolCalls.id,
          capability: toolCalls.capability,
          input: toolCalls.input,
          effect: toolCalls.effect,
          ruleId: toolCalls.ruleId,
          reason: toolCalls.reason,
          output: toolCalls.output,
          durationMs: toolCalls.durationMs,
          createdAt: toolCalls.createdAt,
        })
        .from(toolCalls)
        .where(eq(toolCalls.runId, id.data))
        .orderBy(asc(toolCalls.createdAt))
        .limit(500);
    },
  );

  app.get("/v1/approvals", { preHandler: g("viewer") }, async () => {
    const rows = await db
      .select({ task: tasks, repo: repos.fullName })
      .from(tasks)
      .innerJoin(repos, eq(repos.id, tasks.repoId))
      .where(inArray(tasks.state, [...APPROVAL_STATES]))
      .orderBy(asc(tasks.updatedAt));
    return rows.map(({ task, repo }) => ({
      id: task.id,
      repo,
      title: task.title,
      state: task.state,
      agent: task.agent,
      risk: task.risk,
      type: task.type,
      issueNumber: task.issueNumber,
      version: task.version,
      lastError: task.lastError,
      updatedAt: task.updatedAt,
    }));
  });

  // Commande humaine : écrite en attente, appliquée par le worker avec le même code que pour GitHub.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/v1/tasks/:id/commands",
    { preHandler: g("member") },
    async (request, reply) => {
      const session = sessionOf(request);
      const parsed = commandSchema.safeParse(request.body);
      const taskId = z.uuid().safeParse(request.params.id);
      if (!parsed.success || !taskId.success) {
        return reply.code(400).send({ error: "commande invalide" });
      }
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId.data));
      if (!task) {
        return reply.code(404).send({ error: "tâche introuvable" });
      }
      const needed = COMMAND_ROLE[requiredRole(parsed.data, task.risk ?? undefined)] ?? "admin";
      const order: JulesRole[] = ["admin", "maintainer", "member", "viewer"];
      if (order.indexOf(session.role) > order.indexOf(needed)) {
        return reply.code(403).send({ error: `rôle ${needed} requis` });
      }
      // Approuver un plan de production exige une passkey au moment même (ARCHITECTURE.md §9).
      const stepUp = session.stepUpUntil !== null && session.stepUpUntil > new Date();
      if (parsed.data.name === "approve" && task.state === "awaiting_plan_approval" && !stepUp) {
        const [production] = await db
          .select({ id: changePlans.id })
          .from(changePlans)
          .where(
            and(
              eq(changePlans.taskId, task.id),
              eq(changePlans.status, "pending_approval"),
              eq(changePlans.environment, "production"),
            ),
          )
          .limit(1);
        if (production) {
          return reply
            .code(403)
            .send({ error: "passkey requise pour approuver la production", stepUp: true });
        }
      }
      const [row] = await db
        .insert(commands)
        .values({
          orgId: session.orgId,
          taskId: task.id,
          source: session.kind,
          authorId: session.userId,
          name: parsed.data.name,
          args: { ...parsed.data, stepUp },
          decision: "pending",
          reason: "en attente du worker",
        })
        .returning({ id: commands.id });
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "command.submitted",
        target: { type: "task", id: task.id },
        data: { command: parsed.data.name, source: session.kind },
      });
      return reply.code(202).send({ commandId: row?.id });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/commands/:id",
    { preHandler: g("viewer") },
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      const [row] = id.success
        ? await db
            .select({
              id: commands.id,
              name: commands.name,
              decision: commands.decision,
              reason: commands.reason,
            })
            .from(commands)
            .where(eq(commands.id, id.data))
        : [];
      return row ?? reply.code(404).send({ error: "commande introuvable" });
    },
  );

  // Création depuis le web : la tâche attend que le worker crée l'issue GitHub correspondante (§10).
  app.post<{ Body: unknown }>("/v1/tasks", { preHandler: g("member") }, async (request, reply) => {
    const session = sessionOf(request);
    const body = z
      .object({
        repoId: z.uuid(),
        title: z.string().trim().min(3).max(200),
        body: z.string().trim().min(1).max(20_000),
      })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "titre ou description invalide" });
    }
    const [repo] = await db.select().from(repos).where(eq(repos.id, body.data.repoId));
    if (!repo) {
      return reply.code(404).send({ error: "repo introuvable" });
    }
    const task = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tasks)
        .values({
          orgId: session.orgId,
          repoId: repo.id,
          agent: "developer",
          title: body.data.title,
          request: body.data.body,
          createdBy: session.userId,
        })
        .returning();
      if (!created) {
        throw new Error("tâche non créée");
      }
      await tx.insert(outbox).values({
        orgId: session.orgId,
        kind: "github.create_issue",
        idempotencyKey: `task:${created.id}:issue`,
        serialKey: `task:${created.id}`,
        payload: { taskId: created.id, requester: session.login },
      });
      await appendAudit(tx, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "task.created",
        target: { type: "task", id: created.id },
        data: { source: "web", repoId: repo.id },
      });
      return created;
    });
    return reply.code(201).send({ id: task.id });
  });

  app.get("/v1/repos", { preHandler: g("viewer") }, () =>
    db
      .select({
        id: repos.id,
        fullName: repos.fullName,
        autonomy: repos.autonomy,
        private: repos.private,
        defaultBranch: repos.defaultBranch,
      })
      .from(repos)
      .orderBy(asc(repos.fullName)),
  );

  // Relever une autonomie est une action sensible ; la baisser ne demande pas de passkey.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/v1/repos/:id",
    { preHandler: g("admin") },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z.object({ autonomy: z.enum(["L0", "L1", "L2"]) }).safeParse(request.body);
      const id = z.uuid().safeParse(request.params.id);
      const [repo] = id.success ? await db.select().from(repos).where(eq(repos.id, id.data)) : [];
      if (!body.success || !repo) {
        return reply.code(400).send({ error: "requête invalide" });
      }
      const raising = body.data.autonomy > repo.autonomy;
      if (raising && (!session.stepUpUntil || session.stepUpUntil < new Date())) {
        return reply
          .code(403)
          .send({ error: "passkey requise pour relever l'autonomie", stepUp: true });
      }
      await db
        .update(repos)
        .set({ autonomy: body.data.autonomy, updatedAt: sql`now()` })
        .where(eq(repos.id, repo.id));
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "repo.autonomy",
        target: { type: "repo", id: repo.id },
        data: { from: repo.autonomy, to: body.data.autonomy },
      });
      return { ok: true };
    },
  );

  app.get("/v1/secrets", { preHandler: g("admin") }, async () => {
    const stored = await db
      .select({ name: secrets.name, updatedAt: secrets.updatedAt })
      .from(secrets);
    const pending = await db
      .select({ name: secretSubmissions.name, createdAt: secretSubmissions.createdAt })
      .from(secretSubmissions);
    return { secrets: stored, pending };
  });

  // Secret en écriture seule (§4.2) : scellé avec la clé publique du worker, l'api ne peut plus le relire.
  app.put<{ Params: { name: string }; Body: unknown }>(
    "/v1/secrets/:name",
    { preHandler: g("admin", true) },
    async (request, reply) => {
      const session = sessionOf(request);
      const name = z
        .string()
        .regex(/^[a-z0-9_]{3,64}$/)
        .safeParse(request.params.name);
      const body = z.object({ value: z.string().min(1).max(64_000) }).safeParse(request.body);
      const [key] = await db.select().from(workerKeys).orderBy(desc(workerKeys.createdAt)).limit(1);
      if (!name.success || !body.success) {
        return reply.code(400).send({ error: "nom ou valeur invalide" });
      }
      if (!key) {
        return reply.code(503).send({ error: "le worker n'a pas encore publié sa clé" });
      }
      await sodium.ready;
      const sealed = sodium.crypto_box_seal(
        sodium.from_string(body.data.value),
        sodium.from_base64(key.publicKey, sodium.base64_variants.ORIGINAL),
      );
      await db.insert(secretSubmissions).values({
        orgId: session.orgId,
        name: name.data,
        sealed: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
        workerKeyId: key.id,
        submittedBy: session.userId,
      });
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "secret.submitted",
        target: { type: "secret", id: name.data },
      });
      return reply.code(202).send({ ok: true });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/v1/audit",
    { preHandler: g("maintainer") },
    (request) =>
      db
        .select({
          seq: auditLog.seq,
          at: auditLog.at,
          actorType: auditLog.actorType,
          actorId: auditLog.actorId,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          data: auditLog.data,
        })
        .from(auditLog)
        .where(eq(auditLog.orgId, DEFAULT_ORG_ID))
        .orderBy(desc(auditLog.seq))
        .limit(Math.min(Number(request.query.limit ?? 100) || 100, 500)),
  );
  app.get("/v1/audit/verify", { preHandler: g("maintainer") }, () =>
    verifyAuditChain(db, DEFAULT_ORG_ID),
  );

  app.get<{ Querystring: { days?: string } }>(
    "/v1/metrics",
    { preHandler: g("viewer") },
    (request) => {
      const until = new Date();
      const days = Math.min(Number(request.query.days ?? 30) || 30, 365);
      return computeMetrics(db, { since: new Date(until.getTime() - days * 86_400_000), until });
    },
  );

  app.get("/v1/evals", { preHandler: g("viewer") }, () =>
    db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(50),
  );

  app.get("/v1/members", { preHandler: g("admin") }, () =>
    db
      .select({ userId: users.id, login: users.login, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .orderBy(asc(users.login)),
  );

  app.get("/v1/stop", { preHandler: g("viewer") }, () =>
    db.select().from(stops).where(isNull(stops.liftedAt)),
  );

  // Arrêt d'urgence : bloqué tout de suite en base ; le worker tue les sandboxes et révoque les jetons.
  app.post<{ Body: unknown }>("/v1/stop", { preHandler: g("admin") }, async (request) => {
    const session = sessionOf(request);
    const reason = z.object({ reason: z.string().max(300).optional() }).safeParse(request.body);
    await db.transaction(async (tx) => {
      await tx.insert(stops).values({
        orgId: session.orgId,
        scope: "global",
        reason: (reason.success ? reason.data.reason : undefined) ?? "arrêt depuis l'interface",
        setBy: session.userId,
      });
      await tx.insert(commands).values({
        orgId: session.orgId,
        source: session.kind,
        authorId: session.userId,
        name: "stop_all",
        args: { name: "stop_all" },
        decision: "pending",
        reason: "en attente du worker",
      });
      await appendAudit(tx, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "stop.requested",
        target: { type: "org", id: session.orgId },
      });
    });
    return { ok: true };
  });

  app.post("/v1/stop/lift", { preHandler: g("admin", true) }, async (request) => {
    const session = sessionOf(request);
    const lifted = await db
      .update(stops)
      .set({ liftedAt: sql`now()`, liftedBy: session.userId })
      .where(and(eq(stops.orgId, session.orgId), isNull(stops.liftedAt)))
      .returning({ id: stops.id });
    await appendAudit(db, {
      orgId: session.orgId,
      actor: { type: "user", id: session.userId },
      action: "stop.lifted",
      target: { type: "org", id: session.orgId },
      data: { lifted: lifted.length },
    });
    return { lifted: lifted.length };
  });

  // Temps réel (SSE) : chaque changement de tâche est poussé ; le client recharge ce qu'il affiche.
  app.get("/v1/events", { preHandler: g("viewer") }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    const client = await options.pool.connect();
    const onNotification = (message: { channel: string; payload?: string }) => {
      reply.raw.write(`event: task\ndata: ${JSON.stringify({ id: message.payload })}\n\n`);
    };
    client.on("notification", onNotification);
    await client.query(`LISTEN ${CHANNELS.tasks}`);
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      client.off("notification", onNotification);
      void client.query(`UNLISTEN ${CHANNELS.tasks}`).finally(() => {
        client.release();
      });
    });
  });
}
