import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendAudit } from "@jules/audit";
import { PLAYBOOKS_PATH, REPO_CONFIG_PATH, parseRepoConfig, type RepoConfig } from "@jules/config";
import {
  and,
  deployments,
  desc,
  eq,
  installations,
  repos,
  servers,
  sql,
  type Db,
  type Tx,
} from "@jules/db";
import {
  classify,
  expandPlan,
  parsePlaybooks,
  type ChangePlan,
  type Playbook,
} from "@jules/devops";
import { clonePristine, readFileAt, revParse, type GitHubApp, type RepoRef } from "@jules/forge";
import { decide } from "@jules/policy";
import type { Logger } from "pino";
import { isStopped } from "../controls.js";
import { enqueueEffect } from "../outbox.js";
import type { PlanOutcome, PlanRow, PlanService } from "./plans.js";
import { blockingFindings } from "../security/audits.js";
import { hostKeyTrusted, type ServerService } from "./servers.js";

// Pipeline de déploiement (WORKFLOW.md §12.2) : PR mergée → CI verte → staging → vérification →
// approbation humaine → production → vérification. Chaque étape est publiée sur GitHub (API
// Deployments), et chaque déploiement garde les PR qu'il contient.

export type DeploymentRow = typeof deployments.$inferSelect;
export type RepoFiles = {
  config: RepoConfig;
  playbooks: Record<string, Playbook>;
  errors: string[];
};

export type DeploymentServiceDeps = {
  db: Db;
  github: GitHubApp;
  plans: PlanService;
  servers: ServerService;
  log: Logger;
  runsDir: string;
};

/**
 * PR mergée sur la branche par défaut d'un repo relié à un serveur de staging : demande de
 * déploiement en attente de la CI. Les merges suivants s'ajoutent à la même demande.
 */
export async function requestDeployment(
  tx: Tx,
  input: { githubRepoId: number; sha: string; prNumber: number; mergedAt: Date },
): Promise<boolean> {
  const [repo] = await tx.select().from(repos).where(eq(repos.githubRepoId, input.githubRepoId));
  if (!repo) {
    return false;
  }
  const [staging] = await tx
    .select()
    .from(servers)
    .where(and(eq(servers.repoId, repo.id), eq(servers.environment, "staging")))
    .limit(1);
  if (!staging) {
    return false;
  }
  const [waiting] = await tx
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.repoId, repo.id),
        eq(deployments.environment, "staging"),
        eq(deployments.status, "waiting_ci"),
      ),
    )
    .for("update");
  if (waiting) {
    const prs = [...new Set([...(waiting.pullRequests as number[]), input.prNumber])];
    await tx
      .update(deployments)
      .set({ ref: input.sha, pullRequests: prs, updatedAt: sql`now()` })
      .where(eq(deployments.id, waiting.id));
    return true;
  }
  await tx.insert(deployments).values({
    orgId: repo.orgId,
    repoId: repo.id,
    serverId: staging.id,
    environment: "staging",
    ref: input.sha,
    status: "waiting_ci",
    playbook: "deploy",
    pullRequests: [input.prNumber],
    mergedAt: input.mergedAt,
  });
  return true;
}

const GITHUB_STATE = {
  succeeded: "success",
  failed: "failure",
  rolled_back: "failure",
  cancelled: "error",
  blocked: "error",
} as const;

export class DeploymentService {
  readonly #deps: DeploymentServiceDeps;

  constructor(deps: DeploymentServiceDeps) {
    this.#deps = deps;
  }

  async #repo(repoId: string): Promise<{ ref: RepoRef; defaultBranch: string } | undefined> {
    const [row] = await this.#deps.db
      .select({ repo: repos, installation: installations })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(eq(repos.id, repoId));
    if (!row) {
      return undefined;
    }
    const [owner, name] = row.repo.fullName.split("/") as [string, string];
    return {
      ref: { installationId: row.installation.githubInstallationId, owner, repo: name },
      defaultBranch: row.repo.defaultBranch ?? "main",
    };
  }

  /** Config et playbooks lus sur la branche par défaut, dans un clone jetable du worker. */
  async #read(repo: { ref: RepoRef; defaultBranch: string }): Promise<RepoFiles> {
    const { github, runsDir } = this.#deps;
    const dir = join(runsDir, `deploy-${randomUUID()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const pristine = join(dir, "pristine.git");
      await clonePristine(
        github.cloneUrl(repo.ref),
        pristine,
        await github.getRepoToken(repo.ref, { contents: "read" }),
      );
      const head = await revParse(pristine, `refs/heads/${repo.defaultBranch}`);
      const { config, errors } = parseRepoConfig(
        await readFileAt(pristine, head, REPO_CONFIG_PATH),
      );
      const text = await readFileAt(pristine, head, PLAYBOOKS_PATH);
      const parsed = text ? parsePlaybooks(text) : { ok: true as const, value: {} };
      return parsed.ok
        ? { config, playbooks: parsed.value, errors }
        : { config, playbooks: {}, errors: [...errors, ...parsed.errors] };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #status(
    tx: Tx,
    d: DeploymentRow,
    state: "queued" | "in_progress" | "success" | "failure" | "error",
    description: string,
  ) {
    await enqueueEffect(tx, {
      orgId: d.orgId,
      kind: "github.deployment_status",
      idempotencyKey: `deployment:${d.id}:status:${state}:${description.slice(0, 40)}`,
      serialKey: `deployment:${d.id}`,
      payload: { deploymentId: d.id, state, description: description.slice(0, 140) },
    });
  }

  async #block(d: DeploymentRow, reason: string, status: "blocked" | "cancelled" = "blocked") {
    await this.#deps.db.transaction(async (tx) => {
      await tx
        .update(deployments)
        .set({ status, reason, endedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(deployments.id, d.id));
      await appendAudit(tx, {
        orgId: d.orgId,
        actor: { type: "system", id: "worker" },
        action: `deployment.${status}`,
        target: { type: "deployment", id: d.id },
        data: { environment: d.environment },
      });
    });
    this.#deps.log.warn({ deploymentId: d.id, reason }, "déploiement arrêté");
  }

  /** Fait avancer les demandes en attente de CI. Renvoie le nombre de déploiements lancés. */
  async advance(): Promise<number> {
    const waiting = await this.#deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.status, "waiting_ci"))
      .orderBy(deployments.createdAt);
    let started = 0;
    for (const d of waiting) {
      try {
        started += (await this.#start(d)) ? 1 : 0;
      } catch (error) {
        this.#deps.log.error(
          { deploymentId: d.id, err: (error as Error).message },
          "déploiement en erreur",
        );
      }
    }
    return started;
  }

  async #start(d: DeploymentRow): Promise<boolean> {
    const { db, github, plans } = this.#deps;
    const repo = await this.#repo(d.repoId);
    if (!repo) {
      await this.#block(d, "repo introuvable");
      return false;
    }
    // 1. La CI du projet doit être verte sur ce commit (les checks de Jules ne comptent pas).
    const checks = (await github.listCheckRuns(repo.ref, d.ref)).filter(
      (c) => !c.name.startsWith("Jules"),
    );
    if (checks.some((c) => c.status !== "completed")) {
      return false;
    }
    const red = checks.find((c) => !["success", "neutral", "skipped"].includes(c.conclusion ?? ""));
    if (red) {
      await this.#block(d, `CI rouge : ${red.name}`);
      return false;
    }
    // 2. Cible, playbook et serveur, d'après la config de la branche par défaut.
    const files = await this.#read(repo);
    const target = files.config.deploy?.[d.environment];
    if (!target) {
      await this.#block(d, `deploy.${d.environment} absent de ${REPO_CONFIG_PATH}`, "cancelled");
      return false;
    }
    const server = await this.#deps.servers.byName(db, d.orgId, target.server);
    const playbook = files.playbooks[target.playbook];
    if (!server || server.environment !== d.environment) {
      await this.#block(d, `serveur ${target.server} introuvable ou d'un autre environnement`);
      return false;
    }
    if (server.frozen) {
      await this.#block(d, `environnement ${d.environment} gelé`);
      return false;
    }
    if (!hostKeyTrusted(server)) {
      await this.#block(d, `clé d'hôte de ${server.name} non validée`);
      return false;
    }
    if (!playbook) {
      await this.#block(d, `playbook ${target.playbook} absent de ${PLAYBOOKS_PATH}`);
      return false;
    }
    if (playbook.verify.length === 0 || playbook.rollback.length === 0) {
      await this.#block(d, `le playbook ${target.playbook} doit déclarer verify et rollback`);
      return false;
    }
    const [previous] = await db
      .select({ ref: deployments.ref })
      .from(deployments)
      .where(
        and(
          eq(deployments.repoId, d.repoId),
          eq(deployments.environment, d.environment),
          eq(deployments.status, "succeeded"),
        ),
      )
      .orderBy(desc(deployments.endedAt))
      .limit(1);
    const previousRef = previous?.ref ?? d.ref;
    const prs = d.pullRequests as number[];
    const plan: ChangePlan = {
      goal: `Déployer ${d.ref.slice(0, 7)} en ${d.environment}`,
      server: server.name,
      environment: server.environment,
      actions: [{ kind: "playbook", name: target.playbook, params: { ref: d.ref } }],
      impact: `déploiement de ${d.ref.slice(0, 7)} (PR ${prs.map((n) => `#${n}`).join(", ") || "aucune"})`,
      verify: [],
      rollback: [],
    };
    const expanded = expandPlan(plan, {
      serverEnvironment: server.environment,
      playbooks: files.playbooks,
      builtins: { previous_ref: previousRef },
    });
    if (!expanded.ok) {
      await this.#block(d, expanded.problems.join(" ; "));
      return false;
    }
    const rank = { read: 0, change: 1, dangerous: 2 } as const;
    const commandClass = expanded.steps
      .filter((s) => s.phase !== "verify")
      .map((s) => classify(s.command, { inPlaybook: true }).class)
      .reduce<"read" | "change" | "dangerous">((a, c) => (rank[c] > rank[a] ? c : a), "read");
    // Un finding critique ou haut ouvert sur le repo ou le serveur bloque `deploy*` (WORKFLOW.md §13.2).
    const blocking = target.playbook.startsWith("deploy")
      ? await blockingFindings(db, d.orgId, { repoId: d.repoId, serverId: server.id })
      : [];
    const decision = decide({
      action: "server_action",
      level: server.level,
      environment: server.environment,
      kind: "playbook",
      commandClass,
      via: "direct",
      hostKeyTrusted: true,
      frozen: server.frozen,
      deployBlocked: blocking.length > 0,
      controls: { stopped: await isStopped(db, d.orgId, { repoId: d.repoId }) },
    });
    if (decision.effect === "deny") {
      const first = blocking[0];
      await this.#block(
        d,
        first
          ? `${decision.reason} : ${first.severity} « ${first.title} » (${first.component})`
          : decision.reason,
      );
      return false;
    }
    // La production passe toujours par une approbation humaine avec passkey (policy).
    const approvalRequired = decision.effect === "require_approval";
    await db.transaction(async (tx) => {
      const row = await plans.submit(tx, {
        server,
        plan,
        steps: expanded.steps,
        approvalRequired,
        deploymentId: d.id,
      });
      const [updated] = await tx
        .update(deployments)
        .set({
          status: approvalRequired ? "pending_approval" : "running",
          serverId: server.id,
          playbook: target.playbook,
          planId: row.id,
          previousRef,
          startedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(deployments.id, d.id), eq(deployments.status, "waiting_ci")))
        .returning();
      if (!updated) {
        throw new Error("déploiement repris par un autre worker");
      }
      await enqueueEffect(tx, {
        orgId: d.orgId,
        kind: "github.deployment",
        idempotencyKey: `deployment:${d.id}:create`,
        serialKey: `deployment:${d.id}`,
        payload: { deploymentId: d.id },
      });
      await this.#status(
        tx,
        updated,
        approvalRequired ? "queued" : "in_progress",
        approvalRequired
          ? "en attente d'approbation humaine"
          : `déploiement par Jules (${target.playbook})`,
      );
      await appendAudit(tx, {
        orgId: d.orgId,
        actor: { type: "system", id: "worker" },
        action: "deployment.started",
        target: { type: "deployment", id: d.id },
        data: { environment: d.environment, planId: row.id, approvalRequired },
      });
    });
    return true;
  }

  /** Appelé dans la transaction qui termine un plan : statut du déploiement, puis promotion. */
  async onPlanFinished(tx: Tx, plan: PlanRow, outcome: PlanOutcome): Promise<void> {
    if (!plan.deploymentId) {
      return;
    }
    const [d] = await tx.select().from(deployments).where(eq(deployments.id, plan.deploymentId));
    if (!d) {
      return;
    }
    const status =
      plan.status === "rejected" || plan.status === "expired"
        ? "cancelled"
        : outcome === "succeeded"
          ? "succeeded"
          : outcome === "rolled_back"
            ? "rolled_back"
            : "failed";
    await tx
      .update(deployments)
      .set({ status, reason: plan.failureReason, endedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(deployments.id, d.id));
    await this.#status(
      tx,
      d,
      GITHUB_STATE[status],
      status === "succeeded" ? "déployé et vérifié" : (plan.failureReason ?? status),
    );
    await appendAudit(tx, {
      orgId: d.orgId,
      actor: { type: "system", id: "worker" },
      action: `deployment.${status}`,
      target: { type: "deployment", id: d.id },
      data: { environment: d.environment, planId: plan.id },
    });
    if (status !== "succeeded" || d.environment !== "staging") {
      return;
    }
    // Staging vérifié : la production attend une approbation humaine (WORKFLOW.md §12.2).
    const [production] = await tx
      .select()
      .from(servers)
      .where(and(eq(servers.repoId, d.repoId), eq(servers.environment, "production")))
      .limit(1);
    if (production) {
      await tx.insert(deployments).values({
        orgId: d.orgId,
        repoId: d.repoId,
        serverId: production.id,
        environment: "production",
        ref: d.ref,
        status: "waiting_ci",
        playbook: d.playbook,
        promotedFrom: d.id,
        pullRequests: d.pullRequests,
        mergedAt: d.mergedAt,
      });
    }
  }
}
