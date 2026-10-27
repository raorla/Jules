import { appendAudit } from "@jules/audit";
import { authorize, commandSchema, effectiveRole } from "@jules/commands";
import {
  and,
  approvals,
  eq,
  installations,
  lessons,
  memberships,
  repos,
  sql,
  tasks,
  users,
  commands,
  type Db,
} from "@jules/db";
import type { RepoRole } from "@jules/forge";
import { applyCommand } from "./conversation.js";
import type { WorkerDeps } from "./deps.js";

// Commandes du web et du desktop (ARCHITECTURE.md §10) : l'api les écrit en attente, le worker les
// revérifie (rôle Jules et permission GitHub de l'auteur, au minimum des deux) puis les applique avec
// le même code que les commandes GitHub. Une approbation ne compte qu'une fois.

type CommandRow = typeof commands.$inferSelect;

async function claim(db: Db): Promise<CommandRow | undefined> {
  const result = await db.execute<{ id: string }>(sql`
    update commands set reason = 'en cours'
    where id = (
      select id from commands where decision = 'pending' and reason <> 'en cours'
      order by created_at limit 1 for update skip locked
    )
    returning id`);
  const id = result.rows[0]?.id;
  if (!id) {
    return undefined;
  }
  const [row] = await db.select().from(commands).where(eq(commands.id, id));
  return row;
}

async function finish(
  db: Db,
  row: CommandRow,
  decision: "applied" | "denied" | "rejected",
  reason: string,
): Promise<void> {
  await db
    .update(commands)
    .set({ decision, reason: reason.slice(0, 500) })
    .where(eq(commands.id, row.id));
  await appendAudit(db, {
    orgId: row.orgId,
    actor: { type: "user", id: row.authorId ?? "inconnu" },
    action: `command.${decision}`,
    target: row.taskId ? { type: "task", id: row.taskId } : { type: "org", id: row.orgId },
    data: { command: row.name, source: row.source },
  });
}

export async function drainWebCommands(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  for (;;) {
    const row = await claim(deps.db);
    if (!row) {
      return processed;
    }
    processed += 1;
    try {
      await applyWebCommand(deps, row);
    } catch (error) {
      await finish(
        deps.db,
        row,
        "rejected",
        `erreur : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function applyWebCommand(deps: WorkerDeps, row: CommandRow): Promise<void> {
  const { db } = deps;
  const parsed = commandSchema.safeParse(row.args);
  const [author] = row.authorId
    ? await db
        .select({ id: users.id, login: users.login, role: memberships.role })
        .from(users)
        .innerJoin(
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.orgId, row.orgId)),
        )
        .where(eq(users.id, row.authorId))
    : [];
  if (!parsed.success || !author) {
    await finish(db, row, "rejected", "commande ou auteur invalide");
    return;
  }
  const cmd = parsed.data;

  if (cmd.name === "stop_all") {
    if (author.role !== "admin") {
      await finish(db, row, "denied", "rôle admin requis");
      return;
    }
    const report = deps.emergency
      ? await deps.emergency.stopAll(`user:${author.id}`)
      : { indisponible: true };
    await finish(db, row, "applied", `arrêt d'urgence : ${JSON.stringify(report)}`);
    return;
  }

  const [found] = row.taskId
    ? await db
        .select({ task: tasks, repo: repos, installation: installations })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .innerJoin(installations, eq(installations.id, repos.installationId))
        .where(eq(tasks.id, row.taskId))
    : [];
  if (!found) {
    await finish(db, row, "rejected", "tâche introuvable");
    return;
  }
  const [owner, name] = found.repo.fullName.split("/") as [string, string];
  // Les droits effectifs sont le minimum entre le rôle Jules et la permission GitHub sur ce repo (§4.2).
  const github: RepoRole = await deps.github.getRepoRole(
    { installationId: found.installation.githubInstallationId, owner, repo: name },
    author.login,
  );
  const effective = effectiveRole(author.role, github);
  const allowed = authorize(cmd, effective, found.task.risk ?? undefined);
  if (!allowed.ok) {
    await finish(db, row, "denied", allowed.reason);
    return;
  }

  if (cmd.name === "lesson") {
    const result = await db
      .update(lessons)
      .set({
        status: cmd.decision === "approve" ? "approved" : "rejected",
        decidedBy: author.id,
        decidedAt: sql`now()`,
      })
      .where(
        and(
          eq(lessons.repoId, found.repo.id),
          eq(lessons.status, "proposed"),
          sql`${lessons.id}::text like ${`${cmd.lessonId}%`}`,
        ),
      )
      .returning({ id: lessons.id });
    await finish(
      db,
      row,
      result.length > 0 ? "applied" : "rejected",
      result.length > 0 ? "leçon décidée" : "leçon introuvable ou déjà décidée",
    );
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, found.task.id)).for("update");
    if (!task) {
      return { ok: false as const, reason: "tâche introuvable" };
    }
    const result = await applyCommand(tx, deps, task, cmd, { type: "user", id: author.id });
    if (result.ok && result.approval) {
      await tx.insert(approvals).values({
        ...result.approval,
        orgId: row.orgId,
        taskId: task.id,
        approverId: author.id,
        commandId: row.id,
      });
    }
    return result;
  });
  await finish(db, row, outcome.ok ? "applied" : "rejected", outcome.reason);
}
