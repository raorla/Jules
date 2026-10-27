import { appendAudit } from "@jules/audit";
import { eq, installations, outbox, repos, sql, tasks, type DbOrTx } from "@jules/db";
import { z } from "zod";
import type { WorkerDeps } from "./deps.js";
import { renderStatusComment, statusMarker } from "./messages.js";

// Effets (ARCHITECTURE.md §17) : une transition écrit l'effet dans `outbox`, dans sa transaction ;
// le worker l'exécute ensuite. Chaque exécuteur est idempotent : un effet rejoué après un crash
// ne produit pas de doublon.

const LEASE_SECONDS = 120;
export const MAX_EFFECT_ATTEMPTS = 10;

const effectPayloads = {
  "github.status_comment": z.object({ taskId: z.uuid() }),
} as const;

export type EffectKind = keyof typeof effectPayloads;

export type Effect<K extends EffectKind = EffectKind> = {
  orgId: string;
  kind: K;
  idempotencyKey: string;
  serialKey?: string;
  payload: z.infer<(typeof effectPayloads)[K]>;
};

/** Écrit un effet ; une clé d'idempotence déjà connue ne crée rien. */
export async function enqueueEffect(tx: DbOrTx, effect: Effect): Promise<void> {
  await tx
    .insert(outbox)
    .values({
      orgId: effect.orgId,
      kind: effect.kind,
      idempotencyKey: effect.idempotencyKey,
      serialKey: effect.serialKey ?? null,
      payload: effect.payload,
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey });
}

type OutboxRow = typeof outbox.$inferSelect;

/**
 * Réserve le prochain effet exécutable. Pour une même `serial_key`, seul le plus ancien effet
 * non terminé est exécutable : les effets d'une tâche passent un par un, dans l'ordre.
 */
async function claimNext(db: DbOrTx): Promise<OutboxRow | undefined> {
  const result = await db.execute<{ id: string }>(sql`
    update outbox set
      status = 'running',
      attempts = attempts + 1,
      locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
    where id = (
      select o.id from outbox o
      where (
          (o.status = 'pending' and o.run_after <= now())
          or (o.status = 'running' and o.locked_until < now())
        )
        and not exists (
          select 1 from outbox earlier
          where o.serial_key is not null
            and earlier.serial_key = o.serial_key
            and earlier.status in ('pending', 'running')
            and (earlier.created_at, earlier.id) < (o.created_at, o.id)
        )
      order by o.run_after, o.created_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = result.rows[0]?.id;
  if (!id) {
    return undefined;
  }
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row;
}

export function backoffSeconds(attempts: number): number {
  return Math.min(5 * 2 ** (attempts - 1), 15 * 60);
}

type Executor = (deps: WorkerDeps, row: OutboxRow) => Promise<Record<string, unknown>>;

const executors: Record<EffectKind, Executor> = {
  "github.status_comment": async ({ db, github, settings }, row) => {
    const { taskId } = effectPayloads["github.status_comment"].parse(row.payload);
    const [found] = await db
      .select({ task: tasks, repo: repos, installation: installations })
      .from(tasks)
      .innerJoin(repos, eq(repos.id, tasks.repoId))
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(eq(tasks.id, taskId));
    if (!found || found.task.issueNumber === null) {
      throw new Error(`tâche ${taskId} introuvable ou sans issue`);
    }
    const { task, repo, installation } = found;
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const ref = { installationId: installation.githubInstallationId, owner, repo: name };
    const issueNumber = task.issueNumber as number;
    // On affiche l'état courant de la tâche : rejouer un effet ancien ne remet pas un état périmé.
    const body = renderStatusComment(task, settings.language);

    if (
      task.statusCommentId !== null &&
      (await github.updateIssueComment(ref, task.statusCommentId, body))
    ) {
      return { commentId: task.statusCommentId, operation: "updated" };
    }
    // Identifiant inconnu (crash entre la création et l'enregistrement) : on cherche le marqueur.
    const existing = await github.findIssueComment(ref, issueNumber, statusMarker(task.id));
    let commentId: number;
    let operation: string;
    if (existing && (await github.updateIssueComment(ref, existing.id, body))) {
      commentId = existing.id;
      operation = "found";
    } else {
      commentId = (await github.createIssueComment(ref, issueNumber, body)).id;
      operation = "created";
    }
    await db.update(tasks).set({ statusCommentId: commentId }).where(eq(tasks.id, task.id));
    return { commentId, operation };
  },
};

/** Exécute les effets en attente jusqu'à ce qu'il n'y en ait plus. Renvoie le nombre traité. */
export async function drainOutbox(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  for (;;) {
    const row = await claimNext(deps.db);
    if (!row) {
      return processed;
    }
    processed += 1;
    const log = deps.log.child({ effectId: row.id, kind: row.kind, attempt: row.attempts });
    try {
      const executor = executors[row.kind as EffectKind] as Executor | undefined;
      if (!executor) {
        throw new Error(`type d'effet inconnu : ${row.kind}`);
      }
      const result = await executor(deps, row);
      await deps.db
        .update(outbox)
        .set({ status: "done", result, doneAt: sql`now()`, lockedUntil: null, lastError: null })
        .where(eq(outbox.id, row.id));
      log.info({ result }, "effet produit");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (row.attempts >= MAX_EFFECT_ATTEMPTS) {
        await deps.db.transaction(async (tx) => {
          await tx
            .update(outbox)
            .set({ status: "failed", lastError: message, lockedUntil: null })
            .where(eq(outbox.id, row.id));
          await appendAudit(tx, {
            orgId: row.orgId,
            actor: { type: "system", id: "worker" },
            action: "effect.failed",
            target: { type: "outbox", id: row.id },
            data: { kind: row.kind, attempts: row.attempts },
          });
        });
        log.error({ err: message }, "effet abandonné après le nombre maximal de tentatives");
      } else {
        await deps.db
          .update(outbox)
          .set({
            status: "pending",
            lastError: message,
            lockedUntil: null,
            runAfter: sql`now() + make_interval(secs => ${backoffSeconds(row.attempts)})`,
          })
          .where(eq(outbox.id, row.id));
        log.warn({ err: message }, "effet en échec, nouvelle tentative plus tard");
      }
    }
  }
}
