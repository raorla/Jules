import { appendAudit } from "@jules/audit";
import { hasRole } from "@jules/commands";
import { artifacts, commands, events, type Tx } from "@jules/db";
import type { RepoRef } from "@jules/forge";
import { z } from "zod";
import { activeTask, storeHumanInput, type Apply } from "./conversation.js";
import type { WorkerDeps } from "./deps.js";
import { requestDeployment } from "./devops/deployments.js";
import { requestRepoAuditOnMerge } from "./security/audits.js";
import { upsertUser } from "./identities.js";
import { applyTransition } from "./transitions.js";

// Événements des PR ouvertes par Jules (WORKFLOW.md §4, phases 8 et 9) :
// - une review humaine « Request changes » relance le développeur sur la même branche ;
// - une PR mergée ou fermée fait passer la tâche au retour d'expérience.

type EventRow = typeof events.$inferSelect;

const account = z.object({ id: z.number(), login: z.string(), type: z.string() });
const base = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: z.object({
    id: z.number(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
    default_branch: z.string().optional(),
  }),
  sender: account,
});
const reviewPayload = base.extend({
  pull_request: z.object({ number: z.number() }),
  review: z.object({
    id: z.number(),
    state: z.string(),
    body: z.string().nullable(),
    user: account,
  }),
});
const closedPayload = base.extend({
  pull_request: z.object({
    number: z.number(),
    merged: z.boolean().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    base: z.object({ ref: z.string() }).optional(),
  }),
});

const ignore =
  (reason: string): Apply =>
  () =>
    Promise.resolve({ status: "ignored", reason });

export async function preparePullRequestReview(deps: WorkerDeps, event: EventRow): Promise<Apply> {
  const parsed = reviewPayload.safeParse(event.payload);
  if (!parsed.success) {
    return ignore("payload_unexpected");
  }
  const p = parsed.data;
  if (
    p.action !== "submitted" ||
    p.review.state.toLowerCase() !== "changes_requested" ||
    p.review.user.type === "Bot"
  ) {
    return ignore("review_not_actionable");
  }
  const ref: RepoRef = {
    installationId: p.installation.id,
    owner: p.repository.owner.login,
    repo: p.repository.name,
  };
  const role = await deps.github.getRepoRole(ref, p.review.user.login);
  const inline = hasRole(role, "write")
    ? await deps.github.listReviewComments(ref, p.pull_request.number, p.review.id)
    : [];

  return async (tx: Tx) => {
    const task = await activeTask(tx, p.repository.id, p.pull_request.number, true);
    if (!task) {
      return { status: "ignored", reason: "no_task_for_pull_request" };
    }
    const userId = await upsertUser(tx, event.orgId, {
      githubId: p.review.user.id,
      login: p.review.user.login,
    });
    const actor = { type: "user" as const, id: userId };
    const record = async (decision: "applied" | "denied" | "rejected", reason: string) => {
      await tx.insert(commands).values({
        orgId: event.orgId,
        taskId: task.id,
        source: "github",
        sourceEventId: event.id,
        authorId: userId,
        name: "request_changes",
        args: { reviewId: p.review.id },
        decision,
        reason,
      });
      await appendAudit(tx, {
        orgId: event.orgId,
        actor,
        action: `command.${decision}`,
        target: { type: "task", id: task.id },
        data: { command: "request_changes", eventId: event.id },
      });
    };
    if (!hasRole(role, "write")) {
      await record("denied", `droit write requis (tu as ${role})`);
      return { status: "ignored", reason: "insufficient_permission" };
    }
    const text = [
      p.review.body ?? "",
      ...inline.map((c) => `- ${c.path}${c.line ? `:${c.line}` : ""} : ${c.body}`),
    ]
      .filter(Boolean)
      .join("\n");
    await storeHumanInput(tx, task, "fix", text || "Changements demandés dans la review GitHub.");
    const result = await applyTransition(tx, task, { type: "human_changes_requested" }, { actor });
    await record(result.ok ? "applied" : "rejected", result.reason);
    return result.ok ? { status: "processed" } : { status: "ignored", reason: result.reason };
  };
}

export function preparePullRequestClosed(event: EventRow): Apply {
  const parsed = closedPayload.safeParse(event.payload);
  if (!parsed.success) {
    return ignore("payload_unexpected");
  }
  const p = parsed.data;
  if (p.action !== "closed") {
    return ignore("pull_request_action_not_handled");
  }
  const merged = p.pull_request.merged === true || Boolean(p.pull_request.merged_at);
  return async (tx: Tx) => {
    // Un merge sur la branche par défaut peut lancer le pipeline de déploiement (WORKFLOW.md §12.2).
    const sha = p.pull_request.merge_commit_sha;
    const onDefault =
      p.pull_request.base === undefined ||
      p.repository.default_branch === undefined ||
      p.pull_request.base.ref === p.repository.default_branch;
    const deploying =
      merged && sha && onDefault
        ? await requestDeployment(tx, {
            githubRepoId: p.repository.id,
            sha,
            prNumber: p.pull_request.number,
            mergedAt: p.pull_request.merged_at ? new Date(p.pull_request.merged_at) : new Date(),
          })
        : false;
    const audited =
      merged && onDefault ? await requestRepoAuditOnMerge(tx, p.repository.id) : false;
    const task = await activeTask(tx, p.repository.id, p.pull_request.number, true);
    if (!task) {
      return deploying || audited
        ? { status: "processed", reason: deploying ? "deployment_requested" : "audit_requested" }
        : { status: "ignored", reason: "no_task_for_pull_request" };
    }
    await tx
      .insert(artifacts)
      .values({
        orgId: task.orgId,
        taskId: task.id,
        kind: "pr_closed",
        version: 1,
        content: { merged, closedBy: p.sender.id },
      })
      .onConflictDoNothing();
    // Fermée pendant que Jules y travaille encore : c'est une annulation.
    const result =
      task.state === "awaiting_human_review"
        ? await applyTransition(tx, task, { type: "pr_closed" }, { extra: { lastError: null } })
        : await applyTransition(
            tx,
            task,
            { type: "cancel" },
            { extra: { lastError: "PR fermée sur GitHub" } },
          );
    return result.ok
      ? { status: "processed", reason: merged ? "merged" : "closed" }
      : { status: "ignored", reason: result.reason };
  };
}
