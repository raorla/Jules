import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, normalize, relative } from "node:path";
import { appendAudit } from "@jules/audit";
import {
  DEFAULT_ORG_ID,
  and,
  desc,
  eq,
  localRepos,
  memberships,
  outbox,
  registerLocalRepo,
  repos,
  sql,
  tasks,
  users,
  type Db,
} from "@jules/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSession, guard, sessionOf } from "./session.js";

// Mode local (M10, ARCHITECTURE.md §4.7) : l'api tourne sur la machine, liée à l'adresse de bouclage.
// Pas de GitHub : le desktop se connecte avec un secret tiré au premier lancement et rangé dans le
// trousseau ; l'api n'en connaît que le hash. Les dossiers git tiennent lieu de repos, et le merge est
// le bouton de l'app, exécuté par le worker (effet `local.merge`).

export type LocalModeOptions = {
  /** sha256 (base64url) du secret de connexion du desktop. */
  loginHash: string;
  /** Dossiers autorisés (montés au même chemin dans le worker) ; vide : tout chemin absolu. */
  roots: readonly string[];
};

const LOCAL_SESSION_HOURS = 24 * 30;
const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Chemin absolu, normalisé, sans `..`, et sous l'un des dossiers autorisés. */
export function allowedLocalPath(path: string, roots: readonly string[]): string | undefined {
  if (!isAbsolute(path) || path.includes("\0")) {
    return undefined;
  }
  const clean = normalize(path).replace(/[\\/]+$/, "");
  if (clean.split(/[\\/]/).includes("..")) {
    return undefined;
  }
  if (roots.length === 0) {
    return clean;
  }
  return roots.some((root) => {
    const rel = relative(normalize(root), clean);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  })
    ? clean
    : undefined;
}

export function registerLocalRoutes(
  app: FastifyInstance,
  options: { db: Db; publicOrigin: string; local: LocalModeOptions },
) {
  const { db } = options;
  const g = (role: "admin" | "maintainer" | "viewer") =>
    guard({ db, publicOrigin: options.publicOrigin }, role);
  const expected = Buffer.from(options.local.loginHash, "base64url");

  app.post<{ Body: unknown }>("/v1/auth/local", async (request, reply) => {
    const body = z
      .object({
        secret: z.string().min(32).max(200),
        login: z
          .string()
          .regex(/^[\w.-]{1,39}$/)
          .optional(),
      })
      .safeParse(request.body);
    const given = body.success ? sha256(body.data.secret) : Buffer.alloc(32);
    if (!body.success || expected.length !== 32 || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: "secret de connexion local invalide" });
    }
    const login = body.data.login ?? "local";
    // Une seule personne sur sa machine : elle est admin de son instance locale.
    const userId = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(
          and(
            eq(users.orgId, DEFAULT_ORG_ID),
            sql`${users.githubUserId} is null`,
            eq(memberships.role, "admin"),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(users)
          .set({ login, updatedAt: sql`now()` })
          .where(eq(users.id, existing.id));
        return existing.id;
      }
      const [user] = await tx
        .insert(users)
        .values({ orgId: DEFAULT_ORG_ID, login, kind: "human" })
        .returning({ id: users.id });
      if (!user) {
        throw new Error("utilisateur local non créé");
      }
      await tx
        .insert(memberships)
        .values({ orgId: DEFAULT_ORG_ID, userId: user.id, role: "admin" });
      return user.id;
    });
    const { token } = await createSession(db, {
      orgId: DEFAULT_ORG_ID,
      userId,
      kind: "desktop",
      ttlHours: LOCAL_SESSION_HOURS,
    });
    await appendAudit(db, {
      orgId: DEFAULT_ORG_ID,
      actor: { type: "user", id: userId },
      action: "session.created",
      target: { type: "user", id: userId },
      data: { via: "local_secret" },
    });
    return {
      token,
      expiresAt: new Date(Date.now() + LOCAL_SESSION_HOURS * 3600_000).toISOString(),
    };
  });

  app.get("/v1/local/repos", { preHandler: g("viewer") }, () =>
    db
      .select({
        id: repos.id,
        fullName: repos.fullName,
        path: localRepos.path,
        defaultBranch: repos.defaultBranch,
        autonomy: repos.autonomy,
      })
      .from(localRepos)
      .innerJoin(repos, eq(repos.id, localRepos.repoId))
      .orderBy(repos.fullName),
  );

  // Ajouter un dossier : l'api ne lit pas le disque ; le worker vérifie le dépôt à la première tâche.
  app.post<{ Body: unknown }>(
    "/v1/local/repos",
    { preHandler: g("admin") },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z
        .object({
          path: z.string().min(1).max(1024),
          defaultBranch: z
            .string()
            .regex(/^[\w./-]{1,100}$/)
            .optional(),
        })
        .safeParse(request.body);
      const path = body.success ? allowedLocalPath(body.data.path, options.local.roots) : undefined;
      if (!body.success || !path) {
        return reply.code(400).send({
          error:
            options.local.roots.length > 0
              ? `dossier refusé : chemin absolu sous ${options.local.roots.join(", ")}`
              : "dossier refusé : chemin absolu attendu",
        });
      }
      const repo = await registerLocalRepo(db, {
        orgId: session.orgId,
        path,
        defaultBranch: body.data.defaultBranch,
      });
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "repo.local_registered",
        target: { type: "repo", id: repo.id },
        data: { forge: "local" },
      });
      return reply.code(201).send({ id: repo.id, fullName: repo.fullName });
    },
  );

  const mergeRequests = (taskId: string) =>
    db
      .select()
      .from(outbox)
      .where(and(eq(outbox.kind, "local.merge"), eq(outbox.serialKey, `task:${taskId}`)))
      .orderBy(desc(outbox.createdAt));

  // Le bouton « Merger » : seule action qui touche la branche de base du dossier, et elle est humaine.
  app.post<{ Params: { id: string } }>(
    "/v1/tasks/:id/merge",
    { preHandler: g("maintainer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const id = z.uuid().safeParse(request.params.id);
      const [row] = id.success
        ? await db
            .select({ task: tasks, forge: repos.forge })
            .from(tasks)
            .innerJoin(repos, eq(repos.id, tasks.repoId))
            .where(eq(tasks.id, id.data))
        : [];
      if (!row) {
        return reply.code(404).send({ error: "tâche introuvable" });
      }
      if (row.forge !== "local" || row.task.prNumber === null) {
        return reply.code(409).send({ error: "pas de demande de merge locale pour cette tâche" });
      }
      if (row.task.state !== "awaiting_human_review") {
        return reply
          .code(409)
          .send({ error: "la tâche n'attend pas de review humaine : merge impossible" });
      }
      const pending = (await mergeRequests(row.task.id)).find((r) =>
        ["pending", "running"].includes(r.status),
      );
      if (pending) {
        return reply.code(202).send({ requestId: pending.id });
      }
      const requestId = crypto.randomUUID();
      const [effect] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(outbox)
          .values({
            orgId: session.orgId,
            kind: "local.merge",
            idempotencyKey: `task:${row.task.id}:merge:${requestId}`,
            serialKey: `task:${row.task.id}`,
            payload: { taskId: row.task.id, userId: session.userId },
          })
          .returning({ id: outbox.id });
        await appendAudit(tx, {
          orgId: session.orgId,
          actor: { type: "user", id: session.userId },
          action: "task.merge_requested",
          target: { type: "task", id: row.task.id },
          data: { prNumber: row.task.prNumber },
        });
        return inserted;
      });
      return reply.code(202).send({ requestId: effect?.id });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/tasks/:id/merge",
    { preHandler: g("viewer") },
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.code(404).send({ error: "tâche introuvable" });
      }
      const [last] = await mergeRequests(id.data);
      if (!last) {
        return { status: "none" };
      }
      const result = (last.result ?? {}) as { operation?: string; sha?: string; reason?: string };
      return {
        status:
          last.status === "done"
            ? result.operation === "merged"
              ? "merged"
              : "refused"
            : last.status === "failed"
              ? "failed"
              : "pending",
        sha: result.sha ?? null,
        reason: result.reason ?? last.lastError ?? null,
        requestedAt: last.createdAt,
      };
    },
  );
}
