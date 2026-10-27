import { appendAudit } from "@jules/audit";
import { and, eq, findings, orgs, repos, servers, sql, tasks, type Tx } from "@jules/db";
import { dueDate, findingKey, isActive, type FindingInput } from "@jules/security";
import type { Masker } from "./masking.js";
import { enqueueEffect } from "../outbox.js";
import type { AuditOutcome, AuditService } from "../security/audits.js";
import type { ToolResult } from "./server-tools.js";

// Outils de l'agent Sécurité (ARCHITECTURE.md §7). Les audits tournent dans le worker, hors de la
// transaction de l'appel ; l'agent ne reçoit que des findings et des noms, jamais une valeur secrète.

export type SecurityTools = { audits: AuditService; masker: Masker };

export type SecurityContext = {
  orgId: string;
  runId: string;
  taskId: string;
  security?: SecurityTools;
};

const unavailable: ToolResult = {
  status: 503,
  text: "Outils d'audit indisponibles dans cette exécution.",
};

function format(outcome: AuditOutcome): string {
  const { audit } = outcome;
  if (audit.status === "failed") {
    return `Audit ${audit.scope} en échec : ${audit.error ?? "raison inconnue"}`;
  }
  const lines = [
    `ok: audit ${audit.scope} terminé (${(audit.scanners as string[]).join(", ")}) : ${outcome.created} nouveau(x), ${outcome.reopened} rouvert(s), ${outcome.resolved} résolu(s).`,
    outcome.active.length > 0 ? "Findings actifs :" : "Aucun finding actif.",
    ...outcome.active.map(
      (f) => `- [${f.id.slice(0, 8)}] ${f.severity} · ${f.status} · ${f.title} (${f.component})`,
    ),
  ];
  if (outcome.inventory) {
    lines.push("", "Fichiers de secrets (noms seulement) :", outcome.inventory);
  }
  return lines.join("\n");
}

async function taskRepo(tx: Tx, taskId: string) {
  const [row] = await tx
    .select({ repoId: tasks.repoId, createdBy: tasks.createdBy })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return row;
}

export async function auditRepo(tx: Tx, ctx: SecurityContext): Promise<ToolResult> {
  const tools = ctx.security;
  const task = await taskRepo(tx, ctx.taskId);
  if (!tools || !task) {
    return unavailable;
  }
  return {
    text: "",
    after: async () =>
      format(
        await tools.audits.runNow({
          orgId: ctx.orgId,
          scope: "repo",
          targetId: task.repoId,
          trigger: "agent",
        }),
      ),
  };
}

export async function auditServer(
  tx: Tx,
  ctx: SecurityContext,
  input: { server: string },
): Promise<ToolResult> {
  const tools = ctx.security;
  if (!tools) {
    return unavailable;
  }
  const [server] = await tx
    .select()
    .from(servers)
    .where(and(eq(servers.orgId, ctx.orgId), eq(servers.name, input.server)));
  if (!server) {
    return { status: 404, text: `Serveur inconnu : « ${input.server} ».` };
  }
  if (server.hostKeyStatus !== "trusted") {
    return { status: 403, text: `Clé d'hôte de ${server.name} non validée : audit impossible.` };
  }
  return {
    text: "",
    after: async () =>
      format(
        await tools.audits.runNow({
          orgId: ctx.orgId,
          scope: "server",
          targetId: server.id,
          trigger: "agent",
        }),
      ),
  };
}

export function auditPlatform(ctx: SecurityContext): ToolResult {
  const tools = ctx.security;
  if (!tools) {
    return unavailable;
  }
  return {
    text: "",
    after: async () =>
      format(
        await tools.audits.runNow({
          orgId: ctx.orgId,
          scope: "platform",
          targetId: ctx.orgId,
          trigger: "agent",
        }),
      ),
  };
}

export function auditImage(): ToolResult {
  return { status: 501, text: "audit_image n'est pas encore disponible (Trivy à intégrer)." };
}

async function findingByPrefix(tx: Tx, orgId: string, prefix: string) {
  const rows = await tx
    .select()
    .from(findings)
    .where(and(eq(findings.orgId, orgId), sql`${findings.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

export async function reportFinding(
  tx: Tx,
  ctx: SecurityContext,
  input: {
    findingId?: string | undefined;
    analysis: string;
    falsePositive: boolean;
    new?:
      | {
          scope: "repo" | "server";
          server?: string | undefined;
          category: FindingInput["category"];
          component: string;
          title: string;
          severity: FindingInput["severity"];
          evidence: string;
        }
      | undefined;
  },
): Promise<ToolResult> {
  const masker = ctx.security?.masker;
  if (!masker) {
    return unavailable;
  }
  const analysis = masker.mask(input.analysis).slice(0, 2000);
  if (input.findingId) {
    const finding = await findingByPrefix(tx, ctx.orgId, input.findingId);
    if (!finding) {
      return { status: 404, text: `Finding introuvable ou ambigu : ${input.findingId}.` };
    }
    await tx
      .update(findings)
      .set({
        analysis,
        falsePositiveSuggested: input.falsePositive,
        // Analysé par l'agent : `open` passe en `triaged` (WORKFLOW.md §13.2).
        status: finding.status === "open" ? "triaged" : finding.status,
        updatedAt: sql`now()`,
      })
      .where(eq(findings.id, finding.id));
    await appendAudit(tx, {
      orgId: ctx.orgId,
      actor: { type: "agent", id: ctx.runId },
      action: "finding.triaged",
      target: { type: "finding", id: finding.id },
      data: { falsePositiveSuggested: input.falsePositive },
    });
    return {
      text: `ok: finding ${finding.id.slice(0, 8)} analysé${input.falsePositive ? " ; faux positif proposé, un humain décidera" : ""}.`,
    };
  }
  const next = input.new;
  const task = await taskRepo(tx, ctx.taskId);
  if (!next || !task) {
    return { status: 400, text: "Donne soit findingId, soit new." };
  }
  let targetId = task.repoId;
  if (next.scope === "server") {
    const [server] = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.orgId, ctx.orgId), eq(servers.name, next.server ?? "")));
    if (!server) {
      return { status: 404, text: `Serveur inconnu : « ${next.server ?? ""} ».` };
    }
    targetId = server.id;
  }
  const finding: FindingInput = {
    ...next,
    targetId,
    scanner: "agent",
    evidence: masker.mask(next.evidence),
  };
  const [row] = await tx
    .insert(findings)
    .values({
      orgId: ctx.orgId,
      scope: finding.scope,
      targetId,
      key: findingKey(finding),
      category: finding.category,
      component: finding.component,
      title: finding.title,
      severity: finding.severity,
      scanner: "agent",
      evidence: finding.evidence,
      analysis,
      status: "triaged",
      dueAt: dueDate(finding.severity, new Date()),
    })
    .onConflictDoNothing()
    .returning({ id: findings.id });
  if (!row) {
    return { status: 409, text: "Ce finding existe déjà : analyse-le avec son findingId." };
  }
  await appendAudit(tx, {
    orgId: ctx.orgId,
    actor: { type: "agent", id: ctx.runId },
    action: "finding.created",
    target: { type: "finding", id: row.id },
    data: { severity: finding.severity, scanner: "agent" },
  });
  return { text: `ok: finding ${row.id.slice(0, 8)} enregistré.` };
}

/**
 * Remédiation (S1, WORKFLOW.md §13.2) : une tâche développeur de type `security`, donc risque `high`
 * avec H1 et H2, ou une demande DevOps. Rien n'est créé sur GitHub pour un repo public ni pour un
 * serveur : la faille serait divulguée.
 */
export async function proposeRemediation(
  tx: Tx,
  ctx: SecurityContext,
  input: { findingId: string; kind: "developer" | "devops"; request: string },
): Promise<ToolResult> {
  const masker = ctx.security?.masker;
  if (!masker) {
    return unavailable;
  }
  const [org] = await tx
    .select({ level: orgs.securityLevel })
    .from(orgs)
    .where(eq(orgs.id, ctx.orgId));
  if (org?.level !== "S1") {
    return {
      status: 403,
      text: "Refusé : niveau S0 (auditeur). Un admin doit passer l'agent Sécurité en S1 pour proposer des remédiations.",
    };
  }
  const finding = await findingByPrefix(tx, ctx.orgId, input.findingId);
  if (!finding || !isActive(finding.status)) {
    return { status: 404, text: `Finding actif introuvable : ${input.findingId}.` };
  }
  if (finding.remediationTaskId) {
    return { status: 409, text: "Une remédiation est déjà en cours pour ce finding." };
  }
  const request = masker.mask(input.request);
  const title = `Sécurité : ${finding.title}`.slice(0, 200);
  let repoId: string;
  if (input.kind === "developer") {
    if (finding.scope !== "repo") {
      return {
        status: 400,
        text: "Une remédiation développeur vise un finding de repo ; pour un serveur, propose une demande DevOps.",
      };
    }
    const [repo] = await tx.select().from(repos).where(eq(repos.id, finding.targetId));
    if (!repo) {
      return { status: 404, text: "Repo du finding introuvable." };
    }
    if (!repo.private) {
      return {
        status: 403,
        text: "Refusé : repo public. Une issue ou une PR divulguerait la faille : la remédiation passe par un humain, hors de GitHub.",
      };
    }
    repoId = repo.id;
  } else {
    const [server] =
      finding.scope === "server"
        ? await tx
            .select({ repoId: servers.repoId })
            .from(servers)
            .where(eq(servers.id, finding.targetId))
        : [];
    const task = await taskRepo(tx, ctx.taskId);
    const candidate = server?.repoId ?? task?.repoId;
    if (!candidate) {
      return {
        status: 400,
        text: "Aucun repo rattaché : la demande DevOps ne peut pas être créée.",
      };
    }
    repoId = candidate;
  }
  const [created] = await tx
    .insert(tasks)
    .values({
      orgId: ctx.orgId,
      repoId,
      agent: input.kind === "developer" ? "developer" : "devops",
      title,
      request: `${request}\n\nFinding ${finding.id} (${finding.severity}) : ${finding.title} · ${finding.component}`,
      ...(input.kind === "developer" ? { type: "security", risk: "high" as const } : {}),
    })
    .returning({ id: tasks.id });
  if (!created) {
    return { status: 500, text: "Tâche non créée." };
  }
  if (input.kind === "developer") {
    // Repo privé : l'issue garde la traçabilité dans GitHub et lance le pipeline développeur.
    await enqueueEffect(tx, {
      orgId: ctx.orgId,
      kind: "github.create_issue",
      idempotencyKey: `remediation:${finding.id}:issue`,
      serialKey: `task:${created.id}`,
      payload: { taskId: created.id, requester: "l'agent Sécurité" },
    });
  }
  await tx
    .update(findings)
    .set({ status: "in_remediation", remediationTaskId: created.id, updatedAt: sql`now()` })
    .where(eq(findings.id, finding.id));
  await appendAudit(tx, {
    orgId: ctx.orgId,
    actor: { type: "agent", id: ctx.runId },
    action: "finding.remediation",
    target: { type: "finding", id: finding.id },
    data: { taskId: created.id, kind: input.kind },
  });
  return { text: `ok: tâche de remédiation ${created.id.slice(0, 8)} créée (${input.kind}).` };
}
