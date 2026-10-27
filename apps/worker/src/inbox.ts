import { appendAudit } from "@jules/audit";
import {
  eq,
  events,
  installations,
  repos,
  sql,
  tasks,
  users,
  type DbOrTx,
  type Tx,
} from "@jules/db";
import { hasAtLeast } from "@jules/forge";
import { z } from "zod";
import type { WorkerDeps } from "./deps.js";
import { enqueueEffect } from "./outbox.js";
import { detectTrigger, type TaskTrigger } from "./triggers.js";

// Traitement des webhooks stockés par le gateway. Un événement est traité en deux temps :
// d'abord les lectures réseau (droits GitHub), puis une seule transaction qui écrit la tâche,
// l'effet, l'audit et le statut de l'événement. Rejouer un événement ne crée rien de plus.

const LEASE_SECONDS = 120;
export const MAX_EVENT_ATTEMPTS = 5;

type EventRow = typeof events.$inferSelect;
type Outcome = { status: "processed" | "ignored"; reason?: string };
/** Écritures d'un événement, appliquées dans la transaction qui le marque traité. */
type Apply = (tx: Tx) => Promise<Outcome>;

function returned<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`${what} : aucune ligne renvoyée`);
  }
  return row;
}

const ignore =
  (reason: string): Apply =>
  () =>
    Promise.resolve({ status: "ignored", reason });

async function claimNext(db: DbOrTx): Promise<EventRow | undefined> {
  const result = await db.execute<{ id: string }>(sql`
    update events set
      status = 'processing',
      attempts = attempts + 1,
      locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
    where id = (
      select id from events
      where (status = 'received' and (locked_until is null or locked_until <= now()))
         or (status = 'processing' and locked_until < now())
      order by received_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = result.rows[0]?.id;
  if (!id) {
    return undefined;
  }
  const [row] = await db.select().from(events).where(eq(events.id, id));
  return row;
}

async function upsertInstallation(
  tx: Tx,
  orgId: string,
  values: { githubInstallationId: number; accountLogin: string; accountType: string },
): Promise<string> {
  const rows = await tx
    .insert(installations)
    .values({ orgId, ...values })
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { accountLogin: values.accountLogin, updatedAt: sql`now()` },
    })
    .returning({ id: installations.id });
  return returned(rows, "installation").id;
}

async function upsertRepo(
  tx: Tx,
  orgId: string,
  installationId: string,
  repo: TaskTrigger["repo"],
) {
  const rows = await tx
    .insert(repos)
    .values({
      orgId,
      forge: "github",
      installationId,
      githubRepoId: repo.githubId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
    })
    .onConflictDoUpdate({
      target: [repos.forge, repos.githubRepoId],
      set: {
        installationId,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: repos.id });
  return returned(rows, "repo").id;
}

async function upsertUser(tx: Tx, orgId: string, sender: TaskTrigger["sender"]): Promise<string> {
  const rows = await tx
    .insert(users)
    .values({ orgId, githubUserId: sender.githubId, login: sender.login, kind: "human" })
    .onConflictDoUpdate({
      target: [users.orgId, users.githubUserId],
      set: { login: sender.login, updatedAt: sql`now()` },
    })
    .returning({ id: users.id });
  return returned(rows, "user").id;
}

async function prepareTrigger(deps: WorkerDeps, event: EventRow): Promise<Apply> {
  const detected = detectTrigger(event.event, event.payload, deps.settings);
  if ("ignored" in detected) {
    return ignore(detected.ignored);
  }
  const trigger = detected.trigger;
  const role = await deps.github.getRepoRole(
    { installationId: trigger.installationId, owner: trigger.repo.owner, repo: trigger.repo.name },
    trigger.sender.login,
  );

  return async (tx) => {
    const orgId = event.orgId;
    const installationId = await upsertInstallation(tx, orgId, {
      githubInstallationId: trigger.installationId,
      accountLogin: trigger.repo.owner,
      accountType: trigger.repo.ownerType,
    });
    const repoId = await upsertRepo(tx, orgId, installationId, trigger.repo);
    const userId = await upsertUser(tx, orgId, trigger.sender);
    const actor = { type: "user" as const, id: userId };

    // Créer une tâche demande `write` ou plus sur le repo (WORKFLOW.md §7).
    if (!hasAtLeast(role, "write")) {
      await appendAudit(tx, {
        orgId,
        actor,
        action: "trigger.denied",
        target: { type: "repo", id: repoId },
        data: { eventId: event.id, issue: trigger.issue.number, role, required: "write" },
      });
      return { status: "ignored", reason: "insufficient_permission" };
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        orgId,
        repoId,
        agent: "developer",
        issueNumber: trigger.issue.number,
        title: trigger.issue.title,
        request: trigger.request,
        createdBy: userId,
        sourceEventId: event.id,
      })
      .onConflictDoNothing()
      .returning();

    if (!task) {
      const [sameEvent] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.sourceEventId, event.id));
      if (sameEvent) {
        return { status: "processed", reason: "already_processed" };
      }
      await appendAudit(tx, {
        orgId,
        actor,
        action: "trigger.ignored",
        target: { type: "repo", id: repoId },
        data: { eventId: event.id, issue: trigger.issue.number, reason: "task_already_active" },
      });
      return { status: "ignored", reason: "task_already_active" };
    }

    await enqueueEffect(tx, {
      orgId,
      kind: "github.status_comment",
      idempotencyKey: `task:${task.id}:status:v${task.version}`,
      serialKey: `task:${task.id}`,
      payload: { taskId: task.id },
    });
    await appendAudit(tx, {
      orgId,
      actor,
      action: "task.created",
      target: { type: "task", id: task.id },
      data: { eventId: event.id, repoId, issue: trigger.issue.number, source: trigger.source },
    });
    return { status: "processed" };
  };
}

const installationPayload = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string(), type: z.string() }),
  }),
});

function prepareInstallation(event: EventRow): Apply {
  const parsed = installationPayload.safeParse(event.payload);
  if (!parsed.success) {
    return ignore("payload_unexpected");
  }
  const { action, installation } = parsed.data;
  return async (tx) => {
    const id = await upsertInstallation(tx, event.orgId, {
      githubInstallationId: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
    });
    const changes =
      action === "deleted"
        ? { deletedAt: sql`now()` }
        : action === "suspend"
          ? { suspendedAt: sql`now()` }
          : action === "unsuspend"
            ? { suspendedAt: null }
            : action === "created"
              ? { deletedAt: null, suspendedAt: null }
              : undefined;
    if (changes) {
      await tx.update(installations).set(changes).where(eq(installations.id, id));
    }
    await appendAudit(tx, {
      orgId: event.orgId,
      actor: { type: "github", id: "app" },
      action: `installation.${action}`,
      target: { type: "installation", id },
      data: { eventId: event.id },
    });
    return { status: "processed" };
  };
}

async function prepare(deps: WorkerDeps, event: EventRow): Promise<Apply> {
  if (event.payload === null) {
    return ignore("payload_purged");
  }
  switch (event.event) {
    case "issues":
    case "issue_comment":
      return prepareTrigger(deps, event);
    case "installation":
      return prepareInstallation(event);
    default:
      return ignore("event_not_handled");
  }
}

/** Traite les événements reçus jusqu'à ce qu'il n'y en ait plus. Renvoie le nombre traité. */
export async function drainEvents(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  for (;;) {
    const event = await claimNext(deps.db);
    if (!event) {
      return processed;
    }
    processed += 1;
    const log = deps.log.child({
      eventId: event.id,
      deliveryId: event.deliveryId,
      event: event.event,
    });
    try {
      const apply = await prepare(deps, event);
      const outcome = await deps.db.transaction(async (tx) => {
        const result = await apply(tx);
        await tx
          .update(events)
          .set({
            status: result.status,
            processedAt: sql`now()`,
            lockedUntil: null,
            lastError: result.reason ?? null,
          })
          .where(eq(events.id, event.id));
        return result;
      });
      log.info(outcome, "événement traité");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = event.attempts >= MAX_EVENT_ATTEMPTS;
      await deps.db.transaction(async (tx) => {
        await tx
          .update(events)
          .set({
            status: failed ? "failed" : "received",
            lastError: message,
            lockedUntil: failed
              ? null
              : sql`now() + make_interval(secs => ${2 ** event.attempts * 2})`,
          })
          .where(eq(events.id, event.id));
        if (failed) {
          await appendAudit(tx, {
            orgId: event.orgId,
            actor: { type: "system", id: "worker" },
            action: "event.failed",
            target: { type: "event", id: event.id },
            data: { event: event.event, attempts: event.attempts },
          });
        }
      });
      log.warn({ err: message, failed }, "échec du traitement de l'événement");
    }
  }
}
