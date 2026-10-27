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
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, pushBranch, remoteBranchSha, type RepoRef } from "@jules/forge";
import {
  detectStack,
  missingRules,
  renderAgentsMd,
  renderCodeowners,
  renderRepoConfig,
  type RepoFiles,
} from "./setup.js";
import { z } from "zod";
import type { WorkerDeps } from "./deps.js";
import { gateG6, reviewSchema, type Review, type Spec } from "@jules/artifacts";
import { renderStatusComment, statusMarker, type StatusView } from "./messages.js";
import { withSpan } from "./tracing.js";
import {
  renderPullRequestBody,
  renderReviewBody,
  type PullRequestContext,
} from "./pull-request.js";

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
  "github.review": z.object({ taskId: z.uuid(), reviewVersion: z.number().int().positive() }),
  "github.pr_ready": z.object({ taskId: z.uuid() }),
  "github.create_issue": z.object({ taskId: z.uuid(), requester: z.string() }),
  "github.setup": z.object({
    installationId: z.number(),
    owner: z.string(),
    repo: z.string(),
    defaultBranch: z.string(),
    issueNumber: z.number(),
    eventId: z.uuid(),
    requester: z.string().regex(/^[\w-]+$/),
    language: z.enum(["fr", "en"]),
  }),
  "github.check_run": z.object({
    taskId: z.uuid(),
    sha: z.string(),
    name: z.string(),
    conclusion: z.enum(["success", "failure", "neutral", "action_required"]),
    title: z.string(),
    summary: z.string(),
  }),
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

  "github.check_run": async ({ db, github }, row) => {
    const p = effectPayloads["github.check_run"].parse(row.payload);
    const { ref } = await loadTask(db, p.taskId);
    // Idempotent : le check run de ce nom sur ce commit est retrouvé et mis à jour.
    const run = await github.upsertCheckRun(ref, {
      name: p.name,
      headSha: p.sha,
      status: "completed",
      conclusion: p.conclusion,
      title: p.title,
      summary: p.summary,
    });
    return { checkRunId: run.id };
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
    const body = renderPullRequestBody(await pullRequestContext(db, task, issueNumber));
    const build = (await latestArtifact(db, taskId, "build")) as
      { commitMessage?: string } | undefined;
    // Une PR déjà ouverte pour cette branche est retrouvée au lieu d'être recréée (§17) ; sa
    // description, avec la matrice de traçabilité, est remise à jour à chaque étape.
    const existing = await github.findPullRequest(ref, task.branch);
    const pr =
      existing ??
      (await github.createPullRequest(ref, {
        head: task.branch,
        base: repo.defaultBranch ?? "main",
        draft: true,
        title: build?.commitMessage ?? task.title,
        body,
      }));
    if (existing) {
      await github.updatePullRequest(ref, pr.number, { body });
    }
    await db.update(tasks).set({ prNumber: pr.number, prUrl: pr.url }).where(eq(tasks.id, taskId));
    return { number: pr.number, url: pr.url, operation: existing ? "updated" : "created" };
  },

  "github.review": async ({ db, github }, row) => {
    const p = effectPayloads["github.review"].parse(row.payload);
    const { task, ref } = await loadTask(db, p.taskId);
    if (!task.prNumber || !task.headSha) {
      throw new Error(`tâche ${p.taskId} sans PR`);
    }
    const [reviewRow] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.taskId, p.taskId),
          eq(artifacts.kind, "review"),
          eq(artifacts.version, p.reviewVersion),
        ),
      );
    if (!reviewRow) {
      throw new Error(`review v${p.reviewVersion} introuvable`);
    }
    const review = reviewSchema.parse(reviewRow.content);
    const spec = (await latestArtifact(db, p.taskId, "spec")) as Spec | undefined;
    const marker = `<!-- jules:review task=${p.taskId} v=${p.reviewVersion} -->`;
    const existing = await github.findReview(ref, task.prNumber, marker);
    if (existing) {
      return { reviewId: existing.id, operation: "found" };
    }
    const created = await github.createReview(ref, task.prNumber, {
      commitId: task.headSha,
      body: renderReviewBody(review, marker, gateG6(review, spec).problems),
      comments: review.findings
        .filter((f): f is typeof f & { line: number } => f.line !== undefined)
        .map((f) => ({ path: f.file, line: f.line, body: `**${f.severity}** : ${f.comment}` })),
    });
    return { reviewId: created.id, operation: "created" };
  },

  "github.setup": async ({ github }, row) => {
    const p = effectPayloads["github.setup"].parse(row.payload);
    const ref = { installationId: p.installationId, owner: p.owner, repo: p.repo };
    const branch = "jules/setup";
    const reply = async (body: string) => {
      const marker = `<!-- jules:reply event=${p.eventId} -->`;
      if (!(await github.findIssueComment(ref, p.issueNumber, marker))) {
        await github.createIssueComment(ref, p.issueNumber, `${marker}\n${body}`);
      }
    };
    const existing = await github.findPullRequest(ref, branch);
    if (existing) {
      await reply(`Jules : l'onboarding est déjà proposé dans ${existing.url}.`);
      return { number: existing.number, operation: "found" };
    }
    const token = await github.getRepoToken(ref, { contents: "write" });
    const url = github.cloneUrl(ref);
    const dir = await mkdtemp(join(tmpdir(), "jules-setup-"));
    try {
      // Clone de la branche par défaut seulement : aucun code d'agent ici, rien n'est exécuté du repo.
      await git(["clone", "--quiet", "--branch", p.defaultBranch, url, dir], { token });
      const files: RepoFiles = {
        has: (path) => existsSync(join(dir, path)),
        read: (path) =>
          existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : undefined,
      };
      const stack = detectStack(files);
      const added: string[] = [];
      const add = async (path: string, content: string) => {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
        added.push(path);
      };
      if (!files.has(".jules/config.yml"))
        await add(".jules/config.yml", renderRepoConfig(stack, p.language));
      if (!files.has("AGENTS.md") && !files.has("CLAUDE.md"))
        await add("AGENTS.md", renderAgentsMd(stack));
      if (!["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"].some((f) => files.has(f)))
        await add(".github/CODEOWNERS", renderCodeowners(p.requester));
      const missing = missingRules(await github.getBranchRules(ref, p.defaultBranch));
      if (added.length === 0) {
        await reply(
          `Jules : ce repo est déjà configuré.${missing.length ? ` Règles de branche à ajouter sur \`${p.defaultBranch}\` : ${missing.join(" ; ")}.` : ""}`,
        );
        return { operation: "already_configured", missing };
      }
      const author = [
        "-c",
        "user.name=Jules",
        "-c",
        "user.email=jules@users.noreply.github.com",
        "-c",
        "commit.gpgsign=false",
      ];
      await git(["checkout", "-q", "-b", branch], { cwd: dir });
      await git(["add", "--", ...added], { cwd: dir });
      await git(
        [...author, "commit", "-q", "-m", "chore(jules): onboarding du repo\n\nJules-Task: setup"],
        { cwd: dir },
      );
      await git(
        ["push", "--quiet", "--no-verify", url, `refs/heads/${branch}:refs/heads/${branch}`],
        { cwd: dir, token },
      );
      const pr = await github.createPullRequest(ref, {
        head: branch,
        base: p.defaultBranch,
        draft: false,
        title: "chore(jules): onboarding du repo",
        body: [
          `Onboarding de Jules, demandé par @${p.requester} (#${p.issueNumber}).`,
          "",
          `**Stack détectée** : ${stack?.name ?? "aucune ; complète les commandes à la main"}.`,
          "",
          "### Fichiers proposés",
          ...added.map((f) => `- \`${f}\``),
          "",
          "Ces fichiers sont des chemins protégés : relis les commandes et les chemins de risque avant de merger. Jules lit toujours sa config sur la branche par défaut.",
          "",
          `### Règles de branche sur \`${p.defaultBranch}\``,
          ...(missing.length
            ? missing.map((m) => `- [ ] ${m}`)
            : ["Toutes les règles recommandées sont actives."]),
          "",
          "<sub>Préparée par Jules. Elle attend la review d'un humain : Jules ne merge jamais.</sub>",
        ].join("\n"),
      });
      await reply(`Jules : onboarding proposé dans ${pr.url}.`);
      return { number: pr.number, operation: "created", added, missing };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  "github.create_issue": async ({ db, github }, row) => {
    const p = effectPayloads["github.create_issue"].parse(row.payload);
    const [found] = await db
      .select({ task: tasks, repo: repos, installation: installations })
      .from(tasks)
      .innerJoin(repos, eq(repos.id, tasks.repoId))
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(eq(tasks.id, p.taskId));
    if (!found) {
      throw new Error(`tâche ${p.taskId} introuvable`);
    }
    const [owner, name] = found.repo.fullName.split("/") as [string, string];
    const ref = { installationId: found.installation.githubInstallationId, owner, repo: name };
    // Tâche créée depuis le web : l'issue garde la traçabilité dans GitHub (§10). Pas de mention de
    // Jules dans le texte, sinon le webhook créerait une seconde tâche.
    const marker = `<!-- jules:task=${p.taskId} -->`;
    const issue =
      (await github.findIssueByMarker(ref, marker)) ??
      (await github.createIssue(ref, {
        title: found.task.title,
        body: `${found.task.request.replaceAll("@", "@\u200b")}\n\n${marker}\n<sub>Créée depuis l'interface de Jules par ${p.requester}.</sub>`,
      }));
    await db
      .update(tasks)
      .set({ issueNumber: issue.number, updatedAt: sql`now()` })
      .where(eq(tasks.id, p.taskId));
    await enqueueEffect(db, {
      orgId: found.task.orgId,
      kind: "github.status_comment",
      idempotencyKey: `task:${p.taskId}:status:created`,
      serialKey: `task:${p.taskId}`,
      payload: { taskId: p.taskId },
    });
    return { issueNumber: issue.number };
  },

  "github.pr_ready": async ({ db, github }, row) => {
    const { taskId } = effectPayloads["github.pr_ready"].parse(row.payload);
    const { task, ref } = await loadTask(db, taskId);
    const pr = task.branch ? await github.findPullRequest(ref, task.branch) : undefined;
    if (!pr) {
      throw new Error(`PR de la tâche ${taskId} introuvable`);
    }
    // En L2, la PR passe en « ready » : GitHub demande alors les reviewers CODEOWNERS.
    await github.markReadyForReview(ref, pr);
    return { number: pr.number, wasDraft: pr.draft };
  },
};

async function pullRequestContext(
  db: Db,
  task: typeof tasks.$inferSelect,
  issueNumber: number,
): Promise<PullRequestContext> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, task.id))
    .orderBy(asc(artifacts.version));
  const last = (kind: string) => rows.filter((r) => r.kind === kind).at(-1);
  const prompts = await db
    .selectDistinct({ promptVersion: runs.promptVersion })
    .from(runs)
    .where(eq(runs.taskId, task.id));
  return {
    task,
    issueNumber,
    spec: last("spec")?.content as Spec | undefined,
    build: last("build")?.content as PullRequestContext["build"],
    gates: last("gate_report")?.content as PullRequestContext["gates"],
    review: last("review")?.content as Review | undefined,
    versions: {
      ...(last("spec") ? { spec: last("spec")?.version } : {}),
      ...(last("design") ? { design: last("design")?.version } : {}),
      prompts: prompts.map((p) => p.promptVersion.replace("/", "@")).sort(),
    },
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
      const result = await withSpan(
        "effect",
        { "jules.effect": row.kind, "jules.attempt": row.attempts },
        () => executor(deps, row),
      );
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
