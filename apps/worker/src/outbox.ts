import { appendAudit } from "@jules/audit";
import {
  and,
  artifacts,
  asc,
  desc,
  eq,
  installations,
  outbox,
  repos,
  runs,
  sql,
  tasks,
  toolCalls,
  type Db,
  type DbOrTx,
} from "@jules/db";
import { pushBranch, remoteBranchSha, type RepoRef } from "@jules/forge";
import { z } from "zod";
import type { WorkerDeps } from "./deps.js";
import { renderStatusComment, statusMarker, type StatusView } from "./messages.js";

// Effets (ARCHITECTURE.md §17) : une transition écrit l'effet dans `outbox`, dans sa transaction ;
// le worker l'exécute ensuite. Chaque exécuteur est idempotent : un effet rejoué après un crash
// ne produit pas de doublon.

const LEASE_SECONDS = 120;
export const MAX_EFFECT_ATTEMPTS = 10;

const effectPayloads = {
  "github.status_comment": z.object({ taskId: z.uuid() }),
  "git.push": z.object({
    taskId: z.uuid(),
    pristineDir: z.string(),
    branch: z.string(),
    sha: z.string(),
  }),
  "github.pull_request": z.object({ taskId: z.uuid() }),
  "github.reply": z.object({
    installationId: z.number(),
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    eventId: z.uuid(),
    body: z.string().max(4000),
  }),
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
            and earlier.seq < o.seq
        )
      order by o.run_after, o.seq
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

async function loadTask(db: Db, taskId: string) {
  const [found] = await db
    .select({ task: tasks, repo: repos, installation: installations })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(eq(tasks.id, taskId));
  if (!found || found.task.issueNumber === null) {
    throw new Error(`tâche ${taskId} introuvable ou sans issue`);
  }
  const [owner, name] = found.repo.fullName.split("/") as [string, string];
  const ref: RepoRef = {
    installationId: found.installation.githubInstallationId,
    owner,
    repo: name,
  };
  return { ...found, ref, issueNumber: found.task.issueNumber };
}

async function latestArtifact(db: Db, taskId: string, kind: string) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind)))
    .orderBy(desc(artifacts.version))
    .limit(1);
  return row?.content;
}

const executors: Record<EffectKind, Executor> = {
  "github.status_comment": async ({ db, github, settings }, row) => {
    const { taskId } = effectPayloads["github.status_comment"].parse(row.payload);
    const { task, ref, issueNumber } = await loadTask(db, taskId);
    const plan = (await latestArtifact(db, taskId, "plan")) as { steps: string[] } | undefined;
    const questions = (await latestArtifact(db, taskId, "questions")) as
      { questions: string[] } | undefined;
    const triage = (await latestArtifact(db, taskId, "triage")) as
      { splitProposal?: { title: string; summary: string }[] } | undefined;
    const spec = (await latestArtifact(db, taskId, "spec")) as StatusView["spec"];
    const design = (await latestArtifact(db, taskId, "design")) as StatusView["design"];
    const updates = await db
      .select({ input: toolCalls.input })
      .from(toolCalls)
      .innerJoin(runs, eq(runs.id, toolCalls.runId))
      .where(
        and(
          eq(runs.taskId, taskId),
          eq(toolCalls.capability, "post_update"),
          eq(toolCalls.effect, "allow"),
        ),
      )
      .orderBy(asc(toolCalls.createdAt));
    // On affiche l'état courant de la tâche : rejouer un effet ancien ne remet pas un état périmé.
    const body = renderStatusComment(
      {
        task,
        ...(plan ? { plan: plan.steps } : {}),
        ...(questions ? { questions: questions.questions } : {}),
        ...(triage?.splitProposal ? { split: triage.splitProposal } : {}),
        ...(spec ? { spec } : {}),
        ...(design ? { design } : {}),
        updates: updates
          .map((u) => (u.input as { message?: string }).message ?? "")
          .filter(Boolean),
      },
      task.language ?? settings.language,
    );

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

  "git.push": async ({ db, github }, row) => {
    const payload = effectPayloads["git.push"].parse(row.payload);
    const { ref } = await loadTask(db, payload.taskId);
    const token = await github.getRepoToken(ref, { contents: "write" });
    const url = github.cloneUrl(ref);
    // Idempotent : si la branche distante est déjà à ce SHA, il n'y a rien à faire.
    if ((await remoteBranchSha(url, payload.branch, token)) === payload.sha) {
      return { branch: payload.branch, sha: payload.sha, operation: "already_pushed" };
    }
    await pushBranch(payload.pristineDir, url, payload.branch, token);
    return { branch: payload.branch, sha: payload.sha, operation: "pushed" };
  },

  "github.reply": async ({ github }, row) => {
    const p = effectPayloads["github.reply"].parse(row.payload);
    const ref = { installationId: p.installationId, owner: p.owner, repo: p.repo };
    const marker = `<!-- jules:reply event=${p.eventId} -->`;
    // Retrouvée par son marqueur après un crash, comme le commentaire de statut.
    const existing = await github.findIssueComment(ref, p.issueNumber, marker);
    if (existing) {
      return { commentId: existing.id, operation: "found" };
    }
    const created = await github.createIssueComment(ref, p.issueNumber, `${marker}\n${p.body}`);
    return { commentId: created.id, operation: "created" };
  },

  "github.pull_request": async ({ db, github }, row) => {
    const { taskId } = effectPayloads["github.pull_request"].parse(row.payload);
    const { task, repo, ref, issueNumber } = await loadTask(db, taskId);
    if (!task.branch) {
      throw new Error(`tâche ${taskId} sans branche`);
    }
    // Une PR déjà ouverte pour cette branche est retrouvée au lieu d'être recréée (§17).
    const pr =
      (await github.findPullRequest(ref, task.branch)) ??
      (await github.createPullRequest(ref, {
        head: task.branch,
        base: repo.defaultBranch ?? "main",
        draft: true,
        ...pullRequestText(
          task,
          issueNumber,
          (await latestArtifact(db, taskId, "build")) as BuildContent | undefined,
        ),
      }));
    await db.update(tasks).set({ prNumber: pr.number, prUrl: pr.url }).where(eq(tasks.id, taskId));
    return { number: pr.number, url: pr.url };
  },
};

type BuildContent = { summary: string; commitMessage: string; testsAdded: string[] };

function pullRequestText(
  task: { id: string; title: string },
  issueNumber: number,
  build: BuildContent | undefined,
) {
  const tests = build?.testsAdded.length
    ? build.testsAdded.map((t) => `- \`${t}\``).join("\n")
    : "_aucun déclaré_";
  return {
    title: build?.commitMessage ?? task.title,
    body: [
      build?.summary ?? "",
      "",
      "### Tests ajoutés",
      tests,
      "",
      "---",
      `Tâche Jules \`${task.id.slice(0, 8)}\` · issue #${issueNumber}`,
      "",
      "<sub>Préparée par Jules. Elle attend la review d'un humain : Jules ne merge jamais.</sub>",
    ].join("\n"),
  };
}

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
