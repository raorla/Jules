import { appendAudit } from "@jules/audit";
import { and, eq, sql, tasks, type Tx } from "@jules/db";
import {
  transition,
  type TaskContext,
  type TaskEvent,
  type TransitionResult,
} from "@jules/workflow";
import { enqueueEffect } from "./outbox.js";

// Application d'un événement de la machine à états à une tâche, dans une transaction :
// transition optimiste (la version doit être celle lue), effet de statut et audit écrits ensemble.
// Deux commandes concurrentes : la première gagne, la seconde voit l'état à jour et est refusée.

export type TaskRow = typeof tasks.$inferSelect;
export type Applied = TransitionResult & { version?: number };

export function contextOf(task: TaskRow): TaskContext {
  return {
    state: task.state,
    autonomy: task.autonomy ?? "L0",
    type: (task.type as TaskContext["type"]) ?? undefined,
    risk: task.risk ?? undefined,
    adrPlanned: task.adrPlanned ?? undefined,
    questionRounds: task.questionRounds,
    iterations: task.iterations,
    reviewRounds: task.reviewRounds,
    resumeState: task.resumeState,
  };
}

export async function applyTransition(
  tx: Tx,
  task: TaskRow,
  event: TaskEvent,
  options: {
    extra?: Partial<typeof tasks.$inferInsert>;
    actor?: { type: "system" | "user"; id: string };
    effects?: (tx: Tx, version: number) => Promise<void>;
  } = {},
): Promise<Applied> {
  const result = transition(contextOf(task), event);
  if (!result.ok) {
    return result;
  }
  const { patch } = result;
  const [updated] = await tx
    .update(tasks)
    .set({
      state: result.next,
      version: sql`${tasks.version} + 1`,
      leaseUntil: null,
      attempts: 0,
      updatedAt: sql`now()`,
      ...(patch.questionRounds !== undefined ? { questionRounds: patch.questionRounds } : {}),
      ...(patch.iterations !== undefined ? { iterations: patch.iterations } : {}),
      ...(patch.reviewRounds !== undefined ? { reviewRounds: patch.reviewRounds } : {}),
      ...(patch.resumeState !== undefined ? { resumeState: patch.resumeState } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.risk !== undefined ? { risk: patch.risk } : {}),
      ...(patch.adrPlanned !== undefined ? { adrPlanned: patch.adrPlanned } : {}),
      ...options.extra,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .returning({ version: tasks.version });
  if (!updated) {
    return { ok: false, reason: "la tâche a changé entre-temps" };
  }
  await options.effects?.(tx, updated.version);
  await enqueueEffect(tx, {
    orgId: task.orgId,
    kind: "github.status_comment",
    idempotencyKey: `task:${task.id}:status:v${updated.version}`,
    serialKey: `task:${task.id}`,
    payload: { taskId: task.id },
  });
  await appendAudit(tx, {
    orgId: task.orgId,
    actor: options.actor ?? { type: "system", id: "orchestrator" },
    action: "task.transition",
    target: { type: "task", id: task.id },
    data: {
      from: task.state,
      to: result.next,
      event: event.type,
      reason: result.reason.slice(0, 200),
      version: updated.version,
    },
  });
  return { ...result, version: updated.version };
}
