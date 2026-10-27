import { appendAudit } from "@jules/audit";
import { and, audits, desc, eq, findings, inArray, repos, servers, sql, type Db } from "@jules/db";
import { findingTransition, securityMetrics, type FindingStatus } from "@jules/security";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard, sessionOf } from "./session.js";

// Routes Sécurité (M8, WORKFLOW.md §13) : findings, décisions humaines, audits, métriques. Accepter un
// risque exige une passkey et une échéance ; un faux positif n'est confirmé que par un humain.

const MAX_ACCEPT_DAYS = 365;

export function registerSecurityRoutes(
  app: FastifyInstance,
  options: { db: Db; publicOrigin: string },
) {
  const { db } = options;
  const g = (role: "admin" | "maintainer" | "member" | "viewer", stepUp = false) =>
    guard({ db, publicOrigin: options.publicOrigin }, role, { stepUp });

  /** Nom lisible de la cible : repo, serveur ou plateforme. */
  const targetNames = async () => {
    const [repoRows, serverRows] = await Promise.all([
      db.select({ id: repos.id, name: repos.fullName }).from(repos),
      db.select({ id: servers.id, name: servers.name }).from(servers),
    ]);
    return new Map([...repoRows, ...serverRows].map((r) => [r.id, r.name]));
  };

  app.get<{ Querystring: { status?: string; scope?: string } }>(
    "/v1/findings",
    { preHandler: g("viewer") },
    async (request) => {
      const statuses = request.query.status?.split(",").filter(Boolean);
      const rows = await db
        .select()
        .from(findings)
        .where(
          and(
            statuses ? inArray(findings.status, statuses as FindingStatus[]) : undefined,
            request.query.scope ? eq(findings.scope, request.query.scope as "repo") : undefined,
          ),
        )
        .orderBy(
          sql`case ${findings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
          desc(findings.lastSeenAt),
        )
        .limit(500);
      const names = await targetNames();
      return rows.map((f) => ({
        id: f.id,
        scope: f.scope,
        target: f.scope === "platform" ? "Jules" : (names.get(f.targetId) ?? f.targetId),
        targetId: f.targetId,
        category: f.category,
        component: f.component,
        title: f.title,
        severity: f.severity,
        status: f.status,
        scanner: f.scanner,
        evidence: f.evidence,
        analysis: f.analysis,
        falsePositiveSuggested: f.falsePositiveSuggested,
        firstSeenAt: f.firstSeenAt,
        lastSeenAt: f.lastSeenAt,
        dueAt: f.dueAt,
        acceptedUntil: f.acceptedUntil,
        reopenCount: f.reopenCount,
        remediationTaskId: f.remediationTaskId,
      }));
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/v1/findings/:id/decision",
    { preHandler: g("maintainer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const id = z.uuid().safeParse(request.params.id);
      const body = z
        .object({
          decision: z.enum(["accept_risk", "false_positive", "reopen"]),
          until: z.iso.datetime().optional(),
          note: z.string().trim().min(3).max(1000),
        })
        .safeParse(request.body);
      if (!id.success || !body.success) {
        return reply.code(400).send({ error: "décision invalide : une justification est requise" });
      }
      const [finding] = await db.select().from(findings).where(eq(findings.id, id.data));
      if (!finding) {
        return reply.code(404).send({ error: "finding introuvable" });
      }
      const { decision, until, note } = body.data;
      if (decision === "accept_risk") {
        // Accepter un risque est une action sensible (ARCHITECTURE.md §4.2) : passkey et échéance.
        if (!session.stepUpUntil || session.stepUpUntil < new Date()) {
          return reply
            .code(403)
            .send({ error: "passkey requise pour accepter un risque", stepUp: true });
        }
        const limit = Date.now() + MAX_ACCEPT_DAYS * 86_400_000;
        if (!until || Date.parse(until) <= Date.now() || Date.parse(until) > limit) {
          return reply
            .code(400)
            .send({ error: "échéance requise, dans le futur et à moins d'un an" });
        }
      }
      const result = findingTransition(finding.status, { type: decision });
      if (!result.ok) {
        return reply.code(409).send({ error: result.reason });
      }
      await db
        .update(findings)
        .set({
          status: result.next,
          decidedBy: session.userId,
          decisionNote: note,
          acceptedUntil: decision === "accept_risk" && until ? new Date(until) : null,
          updatedAt: sql`now()`,
        })
        .where(eq(findings.id, finding.id));
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: `finding.${decision}`,
        target: { type: "finding", id: finding.id },
        data: { from: finding.status, to: result.next, ...(until ? { until } : {}) },
      });
      return { ok: true, status: result.next };
    },
  );

  app.get("/v1/security/metrics", { preHandler: g("viewer") }, async () => {
    const rows = await db.select().from(findings);
    return securityMetrics(rows, new Date());
  });

  app.get("/v1/audits", { preHandler: g("viewer") }, async () => {
    const names = await targetNames();
    const rows = await db.select().from(audits).orderBy(desc(audits.createdAt)).limit(50);
    return rows.map((a) => ({
      id: a.id,
      scope: a.scope,
      target: a.scope === "platform" ? "Jules" : (names.get(a.targetId) ?? a.targetId),
      trigger: a.trigger,
      status: a.status,
      summary: a.summary,
      error: a.error,
      createdAt: a.createdAt,
      endedAt: a.endedAt,
    }));
  });

  // Audit à la demande : le worker l'exécute ; l'api ne se connecte à rien.
  app.post<{ Body: unknown }>(
    "/v1/audits",
    { preHandler: g("maintainer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const body = z
        .object({ scope: z.enum(["repo", "server", "platform"]), targetId: z.uuid().optional() })
        .safeParse(request.body);
      if (!body.success || (body.data.scope !== "platform" && !body.data.targetId)) {
        return reply.code(400).send({ error: "cible invalide" });
      }
      const targetId =
        body.data.scope === "platform" ? session.orgId : (body.data.targetId as string);
      const [pending] = await db
        .select({ id: audits.id })
        .from(audits)
        .where(and(eq(audits.targetId, targetId), inArray(audits.status, ["requested", "running"])))
        .limit(1);
      if (pending) {
        return reply.code(202).send({ auditId: pending.id });
      }
      const [row] = await db
        .insert(audits)
        .values({
          orgId: session.orgId,
          scope: body.data.scope,
          targetId,
          trigger: "manual",
          status: "requested",
          requestedBy: session.userId,
        })
        .returning({ id: audits.id });
      return reply.code(202).send({ auditId: row?.id });
    },
  );
}
