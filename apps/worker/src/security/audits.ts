import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendAudit } from "@jules/audit";
import {
  and,
  audits,
  auditLog,
  eq,
  findings,
  inArray,
  installations,
  lt,
  memberships,
  orgs,
  passkeys,
  repos,
  servers,
  sql,
  type Db,
  type DbOrTx,
  type Tx,
} from "@jules/db";
import {
  clonePristine,
  git,
  readFileAt,
  revParse,
  type GitHubApp,
  type RepoRef,
} from "@jules/forge";
import { queryOsv } from "@jules/gates";
import {
  SERVER_AUDIT_SCRIPT,
  blocksDeploy,
  dependencyFindings,
  describeInventory,
  dueDate,
  findingKey,
  infraFindings,
  parseServerAudit,
  platformFindings,
  reconcile,
  repoPackages,
  secretFindings,
  type FindingInput,
  type FindingStatus,
  type Scope,
  type Severity,
} from "@jules/security";
import type { Logger } from "pino";
import type { Masker } from "../broker/masking.js";
import type { ServerService } from "../devops/servers.js";
import { enqueueEffect } from "../outbox.js";

// Audits de sécurité (WORKFLOW.md §13.1) : exécutés par le worker, jamais par l'agent. Les résultats
// des scanners deviennent directement des findings ; un finding n'est résolu que si un nouvel audit
// ne le retrouve plus. Seuls les repos privés reçoivent quelque chose sur GitHub.

export type AuditRow = typeof audits.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;

export type AuditServiceDeps = {
  db: Db;
  github: GitHubApp;
  servers: ServerService;
  masker: Masker;
  log: Logger;
  runsDir: string;
  osv?: { baseUrl?: string; fetchImpl?: typeof fetch };
  /** Fréquence des audits planifiés (WORKFLOW.md §13.1 : chaque semaine). */
  scheduleDays?: number;
};

export type AuditOutcome = {
  audit: AuditRow;
  created: number;
  reopened: number;
  resolved: number;
  active: {
    id: string;
    severity: Severity;
    title: string;
    component: string;
    status: FindingStatus;
  }[];
  /** Audit serveur : fichiers de secrets décrits par des noms et des états seulement. */
  inventory?: string;
};

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;
const ACTIVE: FindingStatus[] = ["open", "triaged", "in_remediation"];

/** Findings critiques ou hauts actifs d'un repo ou d'un serveur : ils bloquent `deploy*` (§13.2). */
export async function blockingFindings(
  db: DbOrTx,
  orgId: string,
  target: { repoId?: string | null; serverId?: string | null },
): Promise<FindingRow[]> {
  const targets = [
    ...(target.repoId
      ? [and(eq(findings.scope, "repo"), eq(findings.targetId, target.repoId))]
      : []),
    ...(target.serverId
      ? [and(eq(findings.scope, "server"), eq(findings.targetId, target.serverId))]
      : []),
  ];
  if (targets.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.orgId, orgId),
        inArray(findings.status, ACTIVE),
        inArray(findings.severity, ["critical", "high"]),
        sql`(${sql.join(targets, sql` or `)})`,
      ),
    );
  return rows.filter((f) => blocksDeploy(f));
}

/** Demande un audit ; un audit déjà en attente ou en cours sur la même cible suffit. */
export async function requestAudit(
  db: DbOrTx,
  input: {
    orgId: string;
    scope: Scope;
    targetId: string;
    trigger: AuditRow["trigger"];
    requestedBy?: string | null;
  },
): Promise<AuditRow> {
  const [pending] = await db
    .select()
    .from(audits)
    .where(
      and(
        eq(audits.scope, input.scope),
        eq(audits.targetId, input.targetId),
        inArray(audits.status, ["requested", "running"]),
      ),
    )
    .limit(1);
  if (pending) {
    return pending;
  }
  const [row] = await db
    .insert(audits)
    .values({
      orgId: input.orgId,
      scope: input.scope,
      targetId: input.targetId,
      trigger: input.trigger,
      status: "requested",
      requestedBy: input.requestedBy ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("audit non enregistré");
  }
  return row;
}

/** Merge sur la branche par défaut : le code a changé, il est réaudité (WORKFLOW.md §13.1). */
export async function requestRepoAuditOnMerge(tx: Tx, githubRepoId: number): Promise<boolean> {
  const [repo] = await tx.select().from(repos).where(eq(repos.githubRepoId, githubRepoId));
  if (!repo) {
    return false;
  }
  await requestAudit(tx, { orgId: repo.orgId, scope: "repo", targetId: repo.id, trigger: "merge" });
  return true;
}

export class AuditService {
  readonly #deps: AuditServiceDeps;

  constructor(deps: AuditServiceDeps) {
    this.#deps = deps;
  }

  async request(
    db: DbOrTx,
    input: {
      orgId: string;
      scope: Scope;
      targetId: string;
      trigger: AuditRow["trigger"];
      requestedBy?: string | null;
    },
  ): Promise<AuditRow> {
    return requestAudit(db, input);
  }

  /** Planification : chaque repo, serveur validé et organisation est audité au moins chaque semaine. */
  async schedule(): Promise<number> {
    const { db } = this.#deps;
    const days = this.#deps.scheduleDays ?? 7;
    const since = new Date(Date.now() - days * 86_400_000);
    const targets: { orgId: string; scope: Scope; targetId: string }[] = [
      ...(await db.select({ orgId: repos.orgId, id: repos.id }).from(repos)).map((r) => ({
        orgId: r.orgId,
        scope: "repo" as const,
        targetId: r.id,
      })),
      ...(
        await db
          .select({ orgId: servers.orgId, id: servers.id })
          .from(servers)
          .where(eq(servers.hostKeyStatus, "trusted"))
      ).map((s) => ({ orgId: s.orgId, scope: "server" as const, targetId: s.id })),
      ...(await db.select({ id: orgs.id }).from(orgs)).map((o) => ({
        orgId: o.id,
        scope: "platform" as const,
        targetId: o.id,
      })),
    ];
    let requested = 0;
    for (const target of targets) {
      const [recent] = await db
        .select({ id: audits.id })
        .from(audits)
        .where(
          and(
            eq(audits.scope, target.scope),
            eq(audits.targetId, target.targetId),
            sql`${audits.createdAt} >= ${since}`,
          ),
        )
        .limit(1);
      if (!recent) {
        await this.request(db, { ...target, trigger: "schedule" });
        requested += 1;
      }
    }
    return requested;
  }

  /** Risques acceptés dont l'échéance est passée : le finding est rouvert (WORKFLOW.md §13.2). */
  async expireAcceptedRisks(): Promise<number> {
    const rows = await this.#deps.db
      .update(findings)
      .set({ status: "open", acceptedUntil: null, updatedAt: sql`now()` })
      .where(and(eq(findings.status, "accepted_risk"), lt(findings.acceptedUntil, sql`now()`)))
      .returning({ id: findings.id, orgId: findings.orgId });
    for (const row of rows) {
      await appendAudit(this.#deps.db, {
        orgId: row.orgId,
        actor: { type: "system", id: "worker" },
        action: "finding.risk_expired",
        target: { type: "finding", id: row.id },
        data: {},
      });
    }
    return rows.length;
  }

  /** Exécute les audits demandés. Renvoie le nombre d'audits traités. */
  async drain(): Promise<number> {
    let done = 0;
    for (;;) {
      const claimed = await this.#deps.db.execute<{ id: string }>(sql`
        update audits set status = 'running', started_at = now()
        where id = (
          select id from audits where status = 'requested'
          order by created_at limit 1 for update skip locked
        )
        returning id`);
      const id = claimed.rows[0]?.id;
      if (!id) {
        return done;
      }
      const [audit] = await this.#deps.db.select().from(audits).where(eq(audits.id, id));
      if (audit) {
        await this.run(audit);
      }
      done += 1;
    }
  }

  /** Demande et exécute tout de suite (outils de l'agent, CLI). */
  async runNow(input: {
    orgId: string;
    scope: Scope;
    targetId: string;
    trigger: AuditRow["trigger"];
  }): Promise<AuditOutcome> {
    const requested = await this.request(this.#deps.db, input);
    const [claimed] = await this.#deps.db
      .update(audits)
      .set({ status: "running", startedAt: sql`now()` })
      .where(and(eq(audits.id, requested.id), eq(audits.status, "requested")))
      .returning();
    if (!claimed) {
      throw new Error("un audit de cette cible est déjà en cours");
    }
    return this.run(claimed);
  }

  async run(audit: AuditRow): Promise<AuditOutcome> {
    const { db, log } = this.#deps;
    try {
      const scanned =
        audit.scope === "repo"
          ? await this.#scanRepo(audit)
          : audit.scope === "server"
            ? await this.#scanServer(audit)
            : audit.scope === "platform"
              ? await this.#scanPlatform(audit)
              : undefined;
      if (!scanned) {
        throw new Error("audit d'images : Trivy n'est pas encore intégré");
      }
      return await db.transaction((tx) => this.#apply(tx, audit, scanned));
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      log.warn({ auditId: audit.id, err: message }, "audit en échec");
      const [failed] = await db
        .update(audits)
        .set({ status: "failed", error: message, endedAt: sql`now()` })
        .where(eq(audits.id, audit.id))
        .returning();
      return { audit: failed ?? audit, created: 0, reopened: 0, resolved: 0, active: [] };
    }
  }

  async #repoRef(repoId: string) {
    const [row] = await this.#deps.db
      .select({ repo: repos, installation: installations })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(eq(repos.id, repoId));
    if (!row) {
      throw new Error("repo introuvable");
    }
    const [owner, name] = row.repo.fullName.split("/") as [string, string];
    const ref: RepoRef = {
      installationId: row.installation.githubInstallationId,
      owner,
      repo: name,
    };
    return { repo: row.repo, ref };
  }

  /** Code, secrets, dépendances et config d'infra, sur la tête de la branche par défaut. */
  async #scanRepo(audit: AuditRow) {
    const { github, runsDir } = this.#deps;
    const { repo, ref } = await this.#repoRef(audit.targetId);
    const dir = join(runsDir, `audit-${randomUUID()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const pristine = join(dir, "pristine.git");
      await clonePristine(
        github.cloneUrl(ref),
        pristine,
        await github.getRepoToken(ref, { contents: "read" }),
      );
      const head = await revParse(pristine, `refs/heads/${repo.defaultBranch ?? "main"}`);
      const listing = await git(["ls-tree", "-r", "-l", "--full-tree", head], { cwd: pristine });
      const files: { path: string; text: string }[] = [];
      for (const line of listing.split("\n").slice(0, MAX_FILES)) {
        const match = /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(line);
        if (!match || match[1] === "-" || Number(match[1]) > MAX_FILE_BYTES) {
          continue;
        }
        const text = await readFileAt(pristine, head, match[2] ?? "");
        if (text !== undefined && !text.includes("\u0000")) {
          files.push({ path: match[2] ?? "", text });
        }
      }
      const results: FindingInput[] = [
        ...secretFindings(repo.id, files),
        ...infraFindings(repo.id, files),
      ];
      const scanners = ["secrets", "infra"];
      try {
        results.push(
          ...dependencyFindings(repo.id, await queryOsv(repoPackages(files), this.#deps.osv ?? {})),
        );
        scanners.push("osv");
      } catch (error) {
        // OSV injoignable : les findings de dépendances ne sont ni créés ni résolus par cet audit.
        this.#deps.log.warn({ err: (error as Error).message }, "OSV injoignable pendant l'audit");
      }
      const publish: "github" | "none" = repo.private ? "github" : "none";
      return { results, scanners, commitSha: head, publish };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Script fixe exécuté par le worker ; la sortie brute n'est pas conservée. */
  async #scanServer(audit: AuditRow) {
    const server = await this.#deps.servers.byId(this.#deps.db, audit.targetId);
    if (!server) {
      throw new Error("serveur introuvable");
    }
    const result = await this.#deps.servers.execute(server, SERVER_AUDIT_SCRIPT, {
      source: "audit",
      commandClass: "read",
      decision: { effect: "allow", ruleId: "security.audit_script", reason: "script d'audit fixe" },
      keepOutput: false,
      timeoutSec: 120,
    });
    const parsed = parseServerAudit(server.id, result.output);
    return {
      results: parsed.findings,
      scanners: ["server-audit"],
      commitSha: null,
      publish: "none" as const,
      inventory: describeInventory(parsed.inventory),
    };
  }

  async #scanPlatform(audit: AuditRow) {
    const { db } = this.#deps;
    const orgId = audit.targetId;
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    const admins = await db
      .select({ id: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin")));
    const withPasskey = new Set(
      (
        await db.select({ userId: passkeys.userId }).from(passkeys).where(eq(passkeys.orgId, orgId))
      ).map((p) => p.userId),
    );
    const serverRows = await db
      .select({ id: servers.id, name: servers.name, hostKeyStatus: servers.hostKeyStatus })
      .from(servers)
      .where(eq(servers.orgId, orgId));
    const [denied] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          sql`(${auditLog.action} like '%.denied' or ${auditLog.action} = 'capability.deny')`,
          sql`${auditLog.at} >= now() - interval '7 days'`,
        ),
      );
    return {
      results: platformFindings({
        orgId,
        admins: admins.map((a) => ({ id: a.id, hasPasskey: withPasskey.has(a.id) })),
        fourEyes: org?.fourEyes ?? false,
        githubProductionApproval: org?.githubProductionApproval ?? false,
        servers: serverRows,
        deniedLast7Days: denied?.count ?? 0,
      }),
      scanners: ["platform-audit"],
      commitSha: null,
      publish: "none" as const,
    };
  }

  /** Applique un audit : créations, rouvertures, résolutions, et publication sur GitHub. */
  async #apply(
    tx: Tx,
    audit: AuditRow,
    scanned: {
      results: FindingInput[];
      scanners: string[];
      commitSha: string | null;
      publish: "none" | "github";
      inventory?: string;
    },
  ): Promise<AuditOutcome> {
    const { masker } = this.#deps;
    const existing = await tx
      .select()
      .from(findings)
      .where(and(eq(findings.scope, audit.scope), eq(findings.targetId, audit.targetId)));
    const plan = reconcile(
      existing.map((f) => ({ id: f.id, key: f.key, status: f.status, scanner: f.scanner })),
      scanned.results,
      scanned.scanners,
    );
    const now = new Date();
    const touched: string[] = [];
    for (const input of plan.create) {
      const [row] = await tx
        .insert(findings)
        .values({
          orgId: audit.orgId,
          scope: input.scope,
          targetId: input.targetId,
          key: findingKey(input),
          category: input.category,
          component: input.component.slice(0, 300),
          title: input.title.slice(0, 300),
          severity: input.severity,
          scanner: input.scanner,
          evidence: masker.mask(input.evidence).slice(0, 1000),
          details: input.details ?? {},
          dueAt: dueDate(input.severity, now),
          lastAuditId: audit.id,
        })
        .returning({ id: findings.id });
      if (row) {
        touched.push(row.id);
        await appendAudit(tx, {
          orgId: audit.orgId,
          actor: { type: "system", id: "worker" },
          action: "finding.created",
          target: { type: "finding", id: row.id },
          data: { severity: input.severity, scanner: input.scanner, auditId: audit.id },
        });
      }
    }
    for (const { id, input } of plan.seen) {
      await tx
        .update(findings)
        .set({
          lastSeenAt: sql`now()`,
          lastAuditId: audit.id,
          evidence: masker.mask(input.evidence).slice(0, 1000),
          updatedAt: sql`now()`,
        })
        .where(eq(findings.id, id));
    }
    for (const { id, input } of plan.reopen) {
      touched.push(id);
      await tx
        .update(findings)
        .set({
          status: "open",
          resolvedAt: null,
          reopenCount: sql`${findings.reopenCount} + 1`,
          lastSeenAt: sql`now()`,
          lastAuditId: audit.id,
          dueAt: dueDate(input.severity, now),
          updatedAt: sql`now()`,
        })
        .where(eq(findings.id, id));
      await appendAudit(tx, {
        orgId: audit.orgId,
        actor: { type: "system", id: "worker" },
        action: "finding.reopened",
        target: { type: "finding", id },
        data: { auditId: audit.id },
      });
    }
    for (const id of plan.resolve) {
      await tx
        .update(findings)
        .set({ status: "resolved", resolvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(findings.id, id));
      await appendAudit(tx, {
        orgId: audit.orgId,
        actor: { type: "system", id: "worker" },
        action: "finding.resolved",
        target: { type: "finding", id },
        data: { auditId: audit.id },
      });
    }
    const active = await tx
      .select({
        id: findings.id,
        severity: findings.severity,
        title: findings.title,
        component: findings.component,
        status: findings.status,
      })
      .from(findings)
      .where(
        and(
          eq(findings.scope, audit.scope),
          eq(findings.targetId, audit.targetId),
          inArray(findings.status, ACTIVE),
        ),
      );
    const summary = {
      created: plan.create.length,
      reopened: plan.reopen.length,
      resolved: plan.resolve.length,
      active: active.length,
    };
    const [updated] = await tx
      .update(audits)
      .set({
        status: "succeeded",
        scanners: scanned.scanners,
        summary,
        commitSha: scanned.commitSha,
        endedAt: sql`now()`,
      })
      .where(eq(audits.id, audit.id))
      .returning();
    // Repo privé : SARIF dans l'onglet Security, issues `security` pour les critiques et hauts.
    // Repo public, serveurs, plateforme : rien n'est publié sur GitHub (WORKFLOW.md §13.2).
    if (scanned.publish === "github" && audit.scope === "repo" && scanned.commitSha) {
      await enqueueEffect(tx, {
        orgId: audit.orgId,
        kind: "github.sarif",
        idempotencyKey: `audit:${audit.id}:sarif`,
        serialKey: `repo:${audit.targetId}:security`,
        payload: { auditId: audit.id },
      });
      const serious = await tx
        .select({
          id: findings.id,
          severity: findings.severity,
          status: findings.status,
          issue: findings.githubIssueNumber,
        })
        .from(findings)
        .where(and(eq(findings.scope, "repo"), eq(findings.targetId, audit.targetId)));
      for (const f of serious) {
        const open =
          ACTIVE.includes(f.status) && (f.severity === "critical" || f.severity === "high");
        if (open && f.issue === null) {
          await enqueueEffect(tx, {
            orgId: audit.orgId,
            kind: "github.security_issue",
            idempotencyKey: `finding:${f.id}:issue:open:${audit.id}`,
            serialKey: `finding:${f.id}`,
            payload: { findingId: f.id, action: "open" },
          });
        } else if (f.status === "resolved" && f.issue !== null && plan.resolve.includes(f.id)) {
          await enqueueEffect(tx, {
            orgId: audit.orgId,
            kind: "github.security_issue",
            idempotencyKey: `finding:${f.id}:issue:close:${audit.id}`,
            serialKey: `finding:${f.id}`,
            payload: { findingId: f.id, action: "close" },
          });
        }
      }
    }
    return {
      audit: updated ?? audit,
      ...summary,
      active,
      ...(scanned.inventory !== undefined ? { inventory: scanned.inventory } : {}),
      created: plan.create.length,
    };
  }
}
