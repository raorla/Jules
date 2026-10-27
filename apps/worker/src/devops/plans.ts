import { createHash } from "node:crypto";
import { appendAudit } from "@jules/audit";
import {
  and,
  artifacts,
  asc,
  changePlans,
  desc,
  eq,
  inArray,
  lt,
  orgs,
  planSteps,
  servers,
  sql,
  tasks,
  type Db,
  type Tx,
} from "@jules/db";
import { classify, type ChangePlan, type PlanStep } from "@jules/devops";
import { decide, type Decision, type HumanRole } from "@jules/policy";
import type { Logger } from "pino";
import { isStopped } from "../controls.js";
import { enqueueEffect } from "../outbox.js";
import { applyTransition } from "../transitions.js";
import { hostKeyTrusted, type ServerRow, type ServerService } from "./servers.js";

// Plans de changement (WORKFLOW.md §12.1). L'agent propose, le worker exécute : les étapes sont
// figées à la soumission et condensées ; seules elles s'exécutent, dans l'ordre, sous le verrou du
// serveur. Chaque étape est journalisée avant et après. Une étape interrompue n'est jamais relancée.

export type PlanRow = typeof changePlans.$inferSelect;
export type PlanOutcome = "succeeded" | "failed" | "rolled_back" | "interrupted";

export type PlanServiceDeps = {
  db: Db;
  servers: ServerService;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Durée du verrou d'un serveur, prolongée tant que le plan s'exécute. */
  lockSeconds?: number;
  approvalMinutes?: number;
  /** Pause entre deux essais d'une vérification HTTP. */
  httpRetryMs?: number;
  /** Appelé dans la transaction qui termine un plan (déploiements). */
  onFinished?: (tx: Tx, plan: PlanRow, outcome: PlanOutcome) => Promise<void>;
};

/** JSON aux clés triées : `jsonb` réordonne les clés, le condensé doit en être indépendant. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planHash(plan: unknown, steps: readonly PlanStep[]): string {
  return createHash("sha256").update(canonical({ plan, steps })).digest("hex");
}

const stepLabel = (step: PlanStep) =>
  step.phase === "verify"
    ? step.check.kind === "http"
      ? `GET ${step.check.url} → ${step.check.expectStatus}`
      : step.check.command
    : step.command;

export type Approver = {
  userId: string;
  role: HumanRole;
  source: "github" | "web" | "desktop" | "cli";
  stepUp: boolean;
};

export class PlanService {
  readonly #deps: PlanServiceDeps;

  constructor(deps: PlanServiceDeps) {
    this.#deps = deps;
  }

  /** Enregistre un plan déjà passé par GC1 : approuvé d'office si le niveau D le permet (HC1). */
  async submit(
    tx: Tx,
    input: {
      server: ServerRow;
      plan: ChangePlan | Record<string, unknown>;
      steps: readonly PlanStep[];
      approvalRequired: boolean;
      taskId?: string | null;
      runId?: string | null;
      deploymentId?: string | null;
      requestedBy?: string | null;
    },
  ): Promise<PlanRow> {
    const minutes = this.#deps.approvalMinutes ?? 30;
    const [row] = await tx
      .insert(changePlans)
      .values({
        orgId: input.server.orgId,
        serverId: input.server.id,
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
        deploymentId: input.deploymentId ?? null,
        plan: input.plan,
        steps: input.steps,
        planHash: planHash(input.plan, input.steps),
        environment: input.server.environment,
        status: input.approvalRequired ? "pending_approval" : "approved",
        requestedBy: input.requestedBy ?? null,
        ...(input.approvalRequired ? {} : { approvedAt: sql`now()`, approvalSource: "auto" }),
        expiresAt: new Date(Date.now() + minutes * 60_000),
      })
      .returning();
    if (!row) {
      throw new Error("plan non enregistré");
    }
    await tx.insert(planSteps).values(
      input.steps.map((step, position) => ({
        orgId: row.orgId,
        planId: row.id,
        position,
        phase: step.phase,
        label: stepLabel(step),
        playbook: step.phase === "verify" ? null : (step.playbook ?? null),
      })),
    );
    await appendAudit(tx, {
      orgId: row.orgId,
      actor: { type: "system", id: "worker" },
      action: "plan.submitted",
      target: { type: "plan", id: row.id },
      data: { serverId: row.serverId, environment: row.environment, status: row.status },
    });
    return row;
  }

  async pendingForTask(tx: Tx, taskId: string): Promise<PlanRow | undefined> {
    const [row] = await tx
      .select()
      .from(changePlans)
      .where(and(eq(changePlans.taskId, taskId), eq(changePlans.status, "pending_approval")))
      .orderBy(desc(changePlans.createdAt))
      .limit(1);
    return row;
  }

  /**
   * Décision humaine sur un plan (HC1). La production exige une passkey, et depuis GitHub un réglage
   * admin ; l'option « quatre yeux » écarte le demandeur. Un refus est définitif pour ce plan.
   */
  async decideOn(
    tx: Tx,
    plan: PlanRow,
    decision: "approve" | "reject",
    approver: Approver,
  ): Promise<{ ok: boolean; reason: string }> {
    if (plan.status !== "pending_approval") {
      return { ok: false, reason: `le plan est déjà ${plan.status}` };
    }
    if (plan.expiresAt.getTime() < Date.now()) {
      return { ok: false, reason: "plan expiré : demande un nouveau plan" };
    }
    if (decision === "reject") {
      await this.#close(tx, plan, "rejected", "refusé par un humain");
      return { ok: true, reason: "plan refusé" };
    }
    const [org] = await tx.select().from(orgs).where(eq(orgs.id, plan.orgId));
    const verdict: Decision = decide({
      action: "approve_plan",
      environment: plan.environment,
      source: approver.source,
      approverRole: approver.role,
      stepUp: approver.stepUp,
      githubProductionApproval: org?.githubProductionApproval ?? false,
      fourEyes: org?.fourEyes ?? false,
      approverIsRequester: plan.requestedBy !== null && plan.requestedBy === approver.userId,
      controls: { stopped: await isStopped(tx, plan.orgId, {}) },
    });
    if (verdict.effect !== "allow") {
      return { ok: false, reason: verdict.reason };
    }
    await tx
      .update(changePlans)
      .set({
        status: "approved",
        approvedBy: approver.userId,
        approvedAt: sql`now()`,
        approvalSource: approver.source,
        updatedAt: sql`now()`,
      })
      .where(and(eq(changePlans.id, plan.id), eq(changePlans.status, "pending_approval")));
    await appendAudit(tx, {
      orgId: plan.orgId,
      actor: { type: "user", id: approver.userId },
      action: "plan.approved",
      target: { type: "plan", id: plan.id },
      data: { environment: plan.environment, source: approver.source, ruleId: verdict.ruleId },
    });
    return { ok: true, reason: verdict.reason };
  }

  async #close(tx: Tx, plan: PlanRow, status: "rejected" | "expired", reason: string) {
    await tx
      .update(changePlans)
      .set({ status, failureReason: reason, endedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(changePlans.id, plan.id));
    await appendAudit(tx, {
      orgId: plan.orgId,
      actor: { type: "system", id: "worker" },
      action: `plan.${status}`,
      target: { type: "plan", id: plan.id },
      data: {},
    });
    await this.#deps.onFinished?.(tx, { ...plan, status }, "failed");
  }

  /** Plans en attente depuis plus de 30 min : expirés, la tâche est bloquée (WORKFLOW.md §12.1). */
  async expire(): Promise<number> {
    const { db } = this.#deps;
    const stale = await db
      .select()
      .from(changePlans)
      .where(
        and(eq(changePlans.status, "pending_approval"), lt(changePlans.expiresAt, sql`now()`)),
      );
    for (const plan of stale) {
      await db.transaction(async (tx) => {
        await this.#close(tx, plan, "expired", "aucune approbation dans le délai");
        if (plan.taskId) {
          const [task] = await tx.select().from(tasks).where(eq(tasks.id, plan.taskId));
          if (task?.state === "awaiting_plan_approval") {
            await applyTransition(
              tx,
              task,
              { type: "plan_expired" },
              {
                extra: { lastError: "plan expiré sans approbation" },
              },
            );
          }
        }
      });
    }
    return stale.length;
  }

  /**
   * Au démarrage du worker : un plan resté `running` a été interrompu. Il passe en `interrupted`,
   * le verrou est rendu, et rien n'est relancé : un humain décide (ARCHITECTURE.md §17).
   */
  async recover(): Promise<number> {
    const { db, log } = this.#deps;
    const running = await db.select().from(changePlans).where(eq(changePlans.status, "running"));
    for (const plan of running) {
      await db.transaction(async (tx) => {
        const [step] = await tx
          .select({ position: planSteps.position, label: planSteps.label })
          .from(planSteps)
          .where(and(eq(planSteps.planId, plan.id), eq(planSteps.status, "running")));
        const reason = step
          ? `worker arrêté pendant l'étape ${step.position + 1} (${step.label}) : résultat inconnu`
          : "worker arrêté pendant le plan";
        await this.#finish(tx, plan, "interrupted", reason);
      });
      log.warn({ planId: plan.id }, "plan interrompu : aucune étape relancée");
    }
    return running.length;
  }

  /** Exécute les plans approuvés, un seul à la fois par serveur. Renvoie le nombre de plans lancés. */
  async drain(): Promise<number> {
    let started = 0;
    for (;;) {
      const claimed = await this.#claim();
      if (!claimed) {
        return started;
      }
      started += 1;
      await this.#execute(claimed.plan, claimed.server);
    }
  }

  /** Exécute un plan précis s'il peut prendre le verrou ; sinon, il passera à son tour. */
  async runOne(planId: string): Promise<string> {
    const { db } = this.#deps;
    const claimed = await this.#claim(planId);
    if (!claimed) {
      return "en attente : le serveur exécute un autre plan, celui-ci passera ensuite";
    }
    await this.#execute(claimed.plan, claimed.server);
    const [row] = await db.select().from(changePlans).where(eq(changePlans.id, planId));
    const steps = await db
      .select()
      .from(planSteps)
      .where(eq(planSteps.planId, planId))
      .orderBy(asc(planSteps.position));
    return [
      `${row?.status ?? "inconnu"}${row?.failureReason ? ` (${row.failureReason})` : ""}`,
      ...steps.map(
        (s) =>
          `- [${s.status}] ${s.label}${s.exitCode !== null ? ` → code ${s.exitCode}` : ""}${s.output ? `\n${s.output.slice(-2000)}` : ""}`,
      ),
    ].join("\n");
  }

  /** Réserve un plan approuvé dont le serveur est libre, et pose le verrou dans la même écriture. */
  async #claim(planId?: string): Promise<{ plan: PlanRow; server: ServerRow } | undefined> {
    const lockSeconds = this.#deps.lockSeconds ?? 900;
    return this.#deps.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ plan: changePlans, server: servers })
        .from(changePlans)
        .innerJoin(servers, eq(servers.id, changePlans.serverId))
        .where(
          and(
            eq(changePlans.status, "approved"),
            planId ? eq(changePlans.id, planId) : undefined,
            sql`(${servers.lockPlanId} is null or ${servers.lockUntil} < now())`,
          ),
        )
        .orderBy(asc(changePlans.approvedAt), asc(changePlans.createdAt))
        .limit(10)
        .for("update", { of: [changePlans], skipLocked: true });
      for (const { plan, server } of candidates) {
        const locked = await tx
          .update(servers)
          .set({
            lockPlanId: plan.id,
            lockUntil: sql`now() + make_interval(secs => ${lockSeconds})`,
          })
          .where(
            and(
              eq(servers.id, server.id),
              sql`(${servers.lockPlanId} is null or ${servers.lockUntil} < now())`,
            ),
          )
          .returning();
        const lockedServer = locked[0];
        if (lockedServer) {
          await tx
            .update(changePlans)
            .set({ status: "running", startedAt: sql`now()`, updatedAt: sql`now()` })
            .where(eq(changePlans.id, plan.id));
          return { plan: { ...plan, status: "running" }, server: lockedServer };
        }
      }
      return undefined;
    });
  }

  async #execute(plan: PlanRow, server: ServerRow): Promise<void> {
    const { db, log } = this.#deps;
    const steps = plan.steps as PlanStep[];
    const heartbeat = setInterval(() => {
      void db
        .update(servers)
        .set({
          lockUntil: sql`now() + make_interval(secs => ${this.#deps.lockSeconds ?? 900})`,
        })
        .where(and(eq(servers.id, server.id), eq(servers.lockPlanId, plan.id)));
    }, 30_000);
    try {
      // Le plan exécuté est celui qui a été approuvé, à l'octet près.
      if (planHash(plan.plan, steps) !== plan.planHash) {
        await this.#end(plan, "failed", "plan modifié après approbation : rien n'est exécuté");
        return;
      }
      const rows = await db
        .select()
        .from(planSteps)
        .where(eq(planSteps.planId, plan.id))
        .orderBy(asc(planSteps.position));
      let failure: string | undefined;
      for (const [index, step] of steps.entries()) {
        if (step.phase === "rollback") {
          continue;
        }
        const stepId = rows[index]?.id;
        if (!stepId) {
          failure = "journal des étapes incomplet";
          break;
        }
        const ok = await this.#runStep(plan, server, step, stepId);
        if (!ok.ok) {
          failure = `étape ${index + 1} : ${ok.reason}`;
          break;
        }
      }
      if (!failure) {
        await this.#skipRollback(plan.id);
        await this.#end(plan, "succeeded", null);
        return;
      }
      // Retour arrière automatique seulement s'il est décrit par un playbook (WORKFLOW.md §12.2).
      const rollback = steps
        .map((step, index) => ({ step, row: rows[index] }))
        .filter(({ step }) => step.phase === "rollback" && step.playbook !== undefined);
      if (rollback.length === 0) {
        await this.#end(plan, "failed", failure);
        return;
      }
      let rolledBack = true;
      for (const { step, row } of rollback) {
        if (!row || !(await this.#runStep(plan, server, step, row.id)).ok) {
          rolledBack = false;
          break;
        }
      }
      await this.#end(
        plan,
        rolledBack ? "rolled_back" : "failed",
        rolledBack
          ? `${failure} ; retour arrière effectué`
          : `${failure} ; retour arrière en échec`,
      );
    } catch (error) {
      log.error({ planId: plan.id, err: (error as Error).message }, "plan en erreur");
      await this.#end(plan, "failed", (error as Error).message);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #skipRollback(planId: string): Promise<void> {
    await this.#deps.db
      .update(planSteps)
      .set({ status: "skipped" })
      .where(and(eq(planSteps.planId, planId), eq(planSteps.status, "pending")));
  }

  /** Une étape : reclassée et revérifiée par la policy juste avant, journalisée avant et après. */
  async #runStep(
    plan: PlanRow,
    server: ServerRow,
    step: PlanStep,
    stepId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { db } = this.#deps;
    const fresh = (await this.#deps.servers.byId(db, server.id)) ?? server;
    const command = step.phase === "verify" ? undefined : step.command;
    const check = step.phase === "verify" ? step.check : undefined;
    const commandText = command ?? (check?.kind === "command" ? check.command : undefined);
    const commandClass = commandText
      ? classify(commandText, {
          inPlaybook: step.phase !== "verify" && step.playbook !== undefined,
        }).class
      : "read";
    const decision = decide({
      action: "server_action",
      level: fresh.level,
      environment: fresh.environment,
      kind: "command",
      commandClass,
      via: "plan",
      hostKeyTrusted: hostKeyTrusted(fresh),
      frozen: fresh.frozen,
      controls: { stopped: await isStopped(db, plan.orgId, {}) },
    });
    if (decision.effect !== "allow") {
      await db
        .update(planSteps)
        .set({ status: "failed", output: decision.reason, endedAt: sql`now()` })
        .where(eq(planSteps.id, stepId));
      return { ok: false, reason: decision.reason };
    }
    // Écrit avant l'exécution : si le worker s'arrête ici, l'étape reste `running` et le plan est
    // déclaré interrompu au redémarrage, sans relance.
    await db
      .update(planSteps)
      .set({ status: "running", startedAt: sql`now()` })
      .where(eq(planSteps.id, stepId));
    const started = Date.now();
    let ok: boolean;
    let output: string;
    let exitCode: number | null = null;
    try {
      if (check?.kind === "http") {
        const result = await this.#httpCheck(check.url, check.expectStatus, check.withinMs);
        ok = result.ok;
        output = result.detail;
      } else {
        const result = await this.#deps.servers.execute(fresh, commandText ?? "", {
          source: plan.deploymentId ? "deployment" : "plan",
          planId: plan.id,
          commandClass,
          decision,
        });
        exitCode = result.exitCode;
        ok = result.exitCode === 0 && !result.timedOut;
        output = result.output;
      }
    } catch (error) {
      ok = false;
      output = (error as Error).message;
    }
    await db
      .update(planSteps)
      .set({
        status: ok ? "done" : "failed",
        exitCode,
        output: output.slice(-30_000),
        durationMs: Date.now() - started,
        endedAt: sql`now()`,
      })
      .where(eq(planSteps.id, stepId));
    return ok
      ? { ok: true }
      : { ok: false, reason: exitCode !== null ? `code ${exitCode}` : output.slice(0, 200) };
  }

  async #httpCheck(
    url: string,
    expected: number,
    withinMs: number,
  ): Promise<{ ok: boolean; detail: string }> {
    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    const deadline = Date.now() + withinMs;
    let last: string;
    for (;;) {
      try {
        const response = await fetchImpl(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        last = `HTTP ${response.status}`;
        if (response.status === expected) {
          return { ok: true, detail: last };
        }
      } catch (error) {
        last = (error as Error).message;
      }
      if (Date.now() >= deadline) {
        return { ok: false, detail: `${last} (attendu ${expected})` };
      }
      await new Promise((resolve) => setTimeout(resolve, this.#deps.httpRetryMs ?? 2000));
    }
  }

  async #end(plan: PlanRow, outcome: Exclude<PlanOutcome, "interrupted">, reason: string | null) {
    await this.#deps.db.transaction((tx) => this.#finish(tx, plan, outcome, reason));
  }

  /** Termine un plan : statut, verrou rendu, rapport, tâche et déploiement mis à jour ensemble. */
  async #finish(tx: Tx, plan: PlanRow, outcome: PlanOutcome, reason: string | null): Promise<void> {
    await tx
      .update(changePlans)
      .set({ status: outcome, failureReason: reason, endedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(changePlans.id, plan.id));
    await tx
      .update(servers)
      .set({ lockPlanId: null, lockUntil: null })
      .where(and(eq(servers.id, plan.serverId), eq(servers.lockPlanId, plan.id)));
    await appendAudit(tx, {
      orgId: plan.orgId,
      actor: { type: "system", id: "worker" },
      action: `plan.${outcome}`,
      target: { type: "plan", id: plan.id },
      data: { serverId: plan.serverId },
    });
    if (plan.taskId) {
      const steps = await tx
        .select({
          label: planSteps.label,
          phase: planSteps.phase,
          status: planSteps.status,
          exitCode: planSteps.exitCode,
          durationMs: planSteps.durationMs,
        })
        .from(planSteps)
        .where(eq(planSteps.planId, plan.id))
        .orderBy(asc(planSteps.position));
      const [last] = await tx
        .select({ version: artifacts.version })
        .from(artifacts)
        .where(and(eq(artifacts.taskId, plan.taskId), eq(artifacts.kind, "plan_report")))
        .orderBy(desc(artifacts.version))
        .limit(1);
      // Rapport rédigé à partir des sorties réelles (WORKFLOW.md §12.1, étape 7).
      await tx.insert(artifacts).values({
        orgId: plan.orgId,
        taskId: plan.taskId,
        kind: "plan_report",
        version: (last?.version ?? 0) + 1,
        content: { planId: plan.id, outcome, reason, steps },
      });
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, plan.taskId));
      if (task?.state === "executing") {
        await applyTransition(
          tx,
          task,
          outcome === "succeeded"
            ? { type: "plan_completed" }
            : outcome === "interrupted"
              ? { type: "plan_interrupted" }
              : { type: "plan_failed", reason: reason ?? outcome },
          { extra: { lastError: outcome === "succeeded" ? null : reason } },
        );
      } else {
        await enqueueEffect(tx, {
          orgId: plan.orgId,
          kind: "github.status_comment",
          idempotencyKey: `task:${plan.taskId}:status:plan:${plan.id}:${outcome}`,
          serialKey: `task:${plan.taskId}`,
          payload: { taskId: plan.taskId },
        });
      }
    }
    await this.#deps.onFinished?.(tx, { ...plan, status: outcome }, outcome);
  }

  /** Plans approuvés dont le serveur est pris : ils attendent leur tour (aucun n'est perdu). */
  async waiting(): Promise<number> {
    const rows = await this.#deps.db
      .select({ id: changePlans.id })
      .from(changePlans)
      .where(inArray(changePlans.status, ["approved"]));
    return rows.length;
  }
}
