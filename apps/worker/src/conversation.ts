import { appendAudit } from "@jules/audit";
import { authorize, parseCommand, type Command } from "@jules/commands";
import {
  and,
  approvals,
  artifacts,
  desc,
  eq,
  lessons,
  events,
  notInArray,
  repos,
  sql,
  tasks,
  commands as commandsTable,
  type Tx,
} from "@jules/db";
import type { RepoRef } from "@jules/forge";
import type { WorkerDeps } from "./deps.js";
import { upsertInstallation, upsertRepo, upsertUser } from "./identities.js";
import { enqueueEffect } from "./outbox.js";
import { applyTransition, type TaskRow } from "./transitions.js";
import { issueCommentPayload } from "./triggers.js";

// Conversation dans une issue suivie par Jules (WORKFLOW.md §7) :
// - une commande `/jules …` est vérifiée (droits GitHub, état de la tâche, version) puis appliquée ;
// - quand la tâche attend une réponse, le commentaire suivant d'une personne autorisée sert de réponse.
// Toute la décision s'écrit dans une transaction : commande, transition, approbation, audit, effets.

type EventRow = typeof events.$inferSelect;
type Outcome = { status: "processed" | "ignored"; reason?: string };
export type Apply = (tx: Tx) => Promise<Outcome>;

const APPROVABLE = ["awaiting_spec_approval", "awaiting_design_approval"] as const;
const DEFAULT_BUDGET_CAP_USD = 50;

/** Tâche en cours d'une issue, ou de la PR que Jules a ouverte pour elle. */
export async function activeTask(
  tx: Tx,
  githubRepoId: number,
  issueNumber: number,
  onPullRequest = false,
): Promise<TaskRow | undefined> {
  const [row] = await tx
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(
      and(
        eq(repos.githubRepoId, githubRepoId),
        onPullRequest ? eq(tasks.prNumber, issueNumber) : eq(tasks.issueNumber, issueNumber),
        notInArray(tasks.state, ["done", "cancelled"]),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  return row?.task;
}

/** Réponse courte dans l'issue, par exemple pour expliquer un refus. Idempotente par événement. */
async function reply(
  tx: Tx,
  orgId: string,
  ref: RepoRef,
  issueNumber: number,
  eventId: string,
  body: string,
): Promise<void> {
  await enqueueEffect(tx, {
    orgId,
    kind: "github.reply",
    idempotencyKey: `reply:${eventId}`,
    payload: { ...ref, issueNumber, eventId, body },
  });
}

/**
 * Prépare le traitement d'un commentaire d'issue : commande ou réponse. Renvoie `undefined` quand le
 * commentaire ne relève pas de la conversation (mention qui crée une tâche, ou rien du tout).
 */
export async function prepareConversation(
  deps: WorkerDeps,
  event: EventRow,
): Promise<Apply | undefined> {
  const parsed = issueCommentPayload.safeParse(event.payload);
  if (!parsed.success) {
    return undefined;
  }
  const p = parsed.data;
  if (p.action !== "created" || p.sender.type === "Bot" || p.comment.user.type === "Bot") {
    return undefined;
  }
  // Dans une PR ouverte par Jules, la conversation porte sur la tâche de cette PR (`/jules fix`…).
  const onPullRequest = p.issue.pull_request !== undefined;
  const ref: RepoRef = {
    installationId: p.installation.id,
    owner: p.repository.owner.login,
    repo: p.repository.name,
  };
  const command = parseCommand(p.comment.body);
  const peek = await deps.db.transaction((tx) =>
    activeTask(tx, p.repository.id, p.issue.number, onPullRequest),
  );
  const isLesson =
    command !== undefined && "command" in command && command.command.name === "lesson";
  if (onPullRequest && (!command || (!peek && !isLesson))) {
    const reason = peek ? "pull_request_comment" : "no_task_for_pull_request";
    return () => Promise.resolve({ status: "ignored" as const, reason });
  }
  if (!command && peek?.state !== "awaiting_info") {
    return undefined;
  }

  const role = await deps.github.getRepoRole(ref, p.sender.login);
  const trigger = {
    installationId: p.installation.id,
    repo: {
      githubId: p.repository.id,
      owner: p.repository.owner.login,
      ownerType: p.repository.owner.type,
      name: p.repository.name,
      fullName: p.repository.full_name,
      private: p.repository.private,
      defaultBranch: p.repository.default_branch ?? null,
    },
    sender: { githubId: p.sender.id, login: p.sender.login },
  };

  // L'arrêt d'urgence agit tout de suite, hors de la transaction : il doit marcher même si le reste échoue.
  let stopReport: string | undefined;
  if (
    command &&
    "command" in command &&
    command.command.name === "stop_all" &&
    authorize(command.command, role, undefined).ok
  ) {
    stopReport = deps.emergency
      ? JSON.stringify(await deps.emergency.stopAll(`github:${p.sender.id}`))
      : "indisponible";
  }

  return async (tx) => {
    const orgId = event.orgId;
    const installationId = await upsertInstallation(tx, orgId, {
      githubInstallationId: trigger.installationId,
      accountLogin: trigger.repo.owner,
      accountType: trigger.repo.ownerType,
    });
    await upsertRepo(tx, orgId, installationId, trigger.repo);
    const userId = await upsertUser(tx, orgId, trigger.sender);
    const actor = { type: "user" as const, id: userId };
    const task = await activeTask(tx, p.repository.id, p.issue.number, onPullRequest);

    if (!command) {
      // Réponse à des questions : seules les personnes qui peuvent créer une tâche peuvent répondre.
      if (!task || task.state !== "awaiting_info") {
        return { status: "ignored", reason: "no_question_pending" };
      }
      if (!authorize({ name: "retry" }, role, task.risk ?? undefined).ok) {
        await appendAudit(tx, {
          orgId,
          actor,
          action: "answer.denied",
          target: { type: "task", id: task.id },
          data: { role, eventId: event.id },
        });
        return { status: "ignored", reason: "insufficient_permission" };
      }
      await storeHumanInput(tx, task, "answer", p.comment.body);
      const result = await applyTransition(tx, task, { type: "answer_received" }, { actor });
      return result.ok ? { status: "processed" } : { status: "ignored", reason: result.reason };
    }

    const record = async (
      name: string,
      args: object,
      decision: "applied" | "denied" | "rejected",
      reason: string,
    ) => {
      const [row] = await tx
        .insert(commandsTable)
        .values({
          orgId,
          taskId: task?.id ?? null,
          source: "github",
          sourceEventId: event.id,
          authorId: userId,
          name,
          args,
          decision,
          reason,
        })
        .returning({ id: commandsTable.id });
      await appendAudit(tx, {
        orgId,
        actor,
        action: `command.${decision}`,
        target: task ? { type: "task", id: task.id } : { type: "org", id: orgId },
        data: { command: name, eventId: event.id },
      });
      return row?.id;
    };

    if ("error" in command) {
      await record("invalid", {}, "rejected", command.error);
      await reply(tx, orgId, ref, p.issue.number, event.id, `Jules : ${command.error}.`);
      return { status: "ignored", reason: "invalid_command" };
    }

    const cmd: Command = command.command;
    const allowed = authorize(cmd, role, task?.risk ?? undefined);
    if (!allowed.ok) {
      await record(cmd.name, cmd, "denied", allowed.reason);
      await reply(
        tx,
        orgId,
        ref,
        p.issue.number,
        event.id,
        `Jules : commande refusée. ${allowed.reason}.`,
      );
      return { status: "ignored", reason: "insufficient_permission" };
    }

    if (cmd.name === "lesson") {
      // Une leçon se valide après la fin de la tâche : elle est cherchée dans le repo, pas dans une tâche en cours.
      const [lesson] = await tx
        .select({ id: lessons.id, status: lessons.status })
        .from(lessons)
        .innerJoin(repos, eq(repos.id, lessons.repoId))
        .where(
          and(
            eq(repos.githubRepoId, p.repository.id),
            sql`${lessons.id}::text like ${`${cmd.lessonId}%`}`,
          ),
        )
        .limit(1);
      if (!lesson || lesson.status !== "proposed") {
        await record(
          cmd.name,
          cmd,
          "rejected",
          lesson ? `leçon déjà ${lesson.status}` : "leçon introuvable",
        );
        await reply(
          tx,
          orgId,
          ref,
          p.issue.number,
          event.id,
          `Jules : leçon \`${cmd.lessonId}\` ${lesson ? `déjà ${lesson.status}` : "introuvable"}.`,
        );
        return { status: "ignored", reason: "lesson_not_pending" };
      }
      const status = cmd.decision === "approve" ? "approved" : "rejected";
      await tx
        .update(lessons)
        .set({ status, decidedBy: userId, decidedAt: sql`now()` })
        .where(eq(lessons.id, lesson.id));
      await record(cmd.name, cmd, "applied", `leçon ${status}`);
      await reply(
        tx,
        orgId,
        ref,
        p.issue.number,
        event.id,
        `Jules : leçon \`${cmd.lessonId}\` ${status === "approved" ? "validée : elle servira aux prochaines tâches" : "rejetée"}.`,
      );
      return { status: "processed" };
    }
    if (cmd.name === "stop_all") {
      await record(cmd.name, cmd, "applied", `arrêt d'urgence : ${stopReport ?? "?"}`);
      await reply(
        tx,
        orgId,
        ref,
        p.issue.number,
        event.id,
        "Jules : **arrêt d'urgence actif**. Toutes les exécutions sont arrêtées ; seul un admin peut le lever, depuis l'interface ou le serveur.",
      );
      return { status: "processed" };
    }
    if (!task) {
      await record(cmd.name, cmd, "rejected", "aucune tâche en cours sur cette issue");
      await reply(
        tx,
        orgId,
        ref,
        p.issue.number,
        event.id,
        "Jules : aucune tâche en cours sur cette issue.",
      );
      return { status: "ignored", reason: "no_task" };
    }

    const result = await applyCommand(tx, deps, task, cmd, actor);
    const commandId = await record(
      cmd.name,
      cmd,
      result.ok ? "applied" : "rejected",
      result.reason,
    );
    if (result.ok && result.approval) {
      await tx.insert(approvals).values({
        ...result.approval,
        orgId,
        taskId: task.id,
        approverId: userId,
        commandId: commandId ?? null,
      });
    }
    if (!result.ok) {
      await reply(
        tx,
        orgId,
        ref,
        p.issue.number,
        event.id,
        `Jules : \`/jules ${cmd.name}\` ignoré : ${result.reason}.`,
      );
    }
    return result.ok ? { status: "processed" } : { status: "ignored", reason: result.reason };
  };
}

type CommandResult =
  | {
      ok: true;
      reason: string;
      approval?: {
        gate: string;
        decision: "approve" | "revise";
        taskVersion: number;
        riskApproved: "low" | "medium" | "high" | null;
        comment: string | null;
      };
    }
  | { ok: false; reason: string };

export async function applyCommand(
  tx: Tx,
  deps: WorkerDeps,
  task: TaskRow,
  cmd: Command,
  actor: { type: "user"; id: string },
): Promise<CommandResult> {
  const gate = task.state === "awaiting_spec_approval" ? "H1" : "H2";
  switch (cmd.name) {
    case "approve":
    case "revise": {
      // Une approbation ne compte qu'une fois : hors d'un état d'attente, la commande est refusée.
      if (!(APPROVABLE as readonly string[]).includes(task.state)) {
        return { ok: false, reason: `rien à valider (état \`${task.state}\`)` };
      }
      if (cmd.name === "revise") {
        await storeHumanInput(tx, task, "revise", cmd.feedback);
      }
      const r = await applyTransition(tx, task, { type: cmd.name }, { actor });
      return r.ok
        ? {
            ok: true,
            reason: r.reason,
            approval: {
              gate,
              decision: cmd.name,
              taskVersion: task.version,
              riskApproved: task.risk,
              comment: cmd.name === "revise" ? cmd.feedback : null,
            },
          }
        : r;
    }
    case "retry":
    case "cancel": {
      const r = await applyTransition(
        tx,
        task,
        { type: cmd.name },
        { actor, ...(cmd.name === "retry" ? { extra: { lastError: null, attempts: 0 } } : {}) },
      );
      return r.ok ? { ok: true, reason: r.reason } : r;
    }
    case "pause":
    case "resume":
      await tx
        .update(tasks)
        .set({ paused: cmd.name === "pause", updatedAt: sql`now()` })
        .where(eq(tasks.id, task.id));
      return { ok: true, reason: cmd.name === "pause" ? "tâche en pause" : "tâche reprise" };
    case "budget": {
      const cap = deps.taskBudgetCapUsd ?? DEFAULT_BUDGET_CAP_USD;
      const current = Number(task.budgetUsd ?? 0);
      const next = Math.min(cap, current + cmd.addUsd);
      await tx
        .update(tasks)
        .set({ budgetUsd: next.toFixed(4), updatedAt: sql`now()` })
        .where(eq(tasks.id, task.id));
      return { ok: true, reason: `budget porté à ${next} $ (plafond ${cap} $)` };
    }
    case "fix": {
      // Retour humain sur la PR : nouvelle itération du développeur sur la même branche (WORKFLOW.md §4, phase 8).
      if (task.state !== "awaiting_human_review") {
        return {
          ok: false,
          reason: `\`/jules fix\` s'utilise quand la PR attend ta review (état \`${task.state}\`)`,
        };
      }
      await storeHumanInput(tx, task, "fix", cmd.instructions);
      const r = await applyTransition(tx, task, { type: "human_changes_requested" }, { actor });
      return r.ok ? { ok: true, reason: r.reason } : r;
    }
    case "stop_all":
      return { ok: true, reason: "arrêt d'urgence" };
    case "lesson":
      return { ok: false, reason: "les leçons sont traitées sans tâche en cours" };
  }
}

export async function storeHumanInput(
  tx: Tx,
  task: TaskRow,
  kind: "answer" | "revise" | "fix",
  text: string,
): Promise<void> {
  const [last] = await tx
    .select({ version: artifacts.version })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, task.id), eq(artifacts.kind, "human_input")))
    .orderBy(desc(artifacts.version))
    .limit(1);
  await tx.insert(artifacts).values({
    orgId: task.orgId,
    taskId: task.id,
    kind: "human_input",
    version: (last?.version ?? 0) + 1,
    content: { kind, text: text.slice(0, 8000), phase: task.resumeState ?? task.state },
  });
}
