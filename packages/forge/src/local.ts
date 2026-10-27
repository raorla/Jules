import {
  LOCAL_INSTALLATION_ID,
  LOCAL_OWNER,
  and,
  desc,
  eq,
  events,
  localChecks,
  localComments,
  localItems,
  localRepos,
  repos,
  sql,
  type Db,
  type Tx,
} from "@jules/db";
import { REQUIRED_EVENTS, REQUIRED_PERMISSIONS, type AppInfo } from "./app-setup.js";
import { git } from "./git.js";
import type {
  CheckRun,
  CheckRunInput,
  GitHubApp,
  HookDelivery,
  NewPullRequest,
  NewReview,
  PullRequest,
  RepoRef,
  RepoRole,
} from "./github.js";

// Forge locale (M10, ARCHITECTURE.md §11) : le même port que GitHub, sur des dossiers git de la
// machine. Les branches de Jules sont poussées dans le repo local ; la review se fait dans l'app, et
// le merge est une action humaine, déclenchée par un bouton. Aucun agent ne merge.

export class LocalMergeError extends Error {}

export class LocalForge implements GitHubApp {
  readonly #db: Db;
  /** Chemins déjà résolus : `cloneUrl` est synchrone dans le port. */
  readonly #paths = new Map<string, string>();

  constructor(db: Db) {
    this.#db = db;
  }

  /** Charge les chemins de tous les repos locaux (au démarrage du worker). */
  async load(): Promise<number> {
    const rows = await this.#db
      .select({ fullName: repos.fullName, path: localRepos.path })
      .from(localRepos)
      .innerJoin(repos, eq(repos.id, localRepos.repoId));
    for (const row of rows) {
      this.#paths.set(row.fullName, row.path);
    }
    return rows.length;
  }

  async #repo(ref: RepoRef) {
    const [row] = await this.#db
      .select({ repo: repos, path: localRepos.path })
      .from(repos)
      .innerJoin(localRepos, eq(localRepos.repoId, repos.id))
      .where(and(eq(repos.forge, "local"), eq(repos.fullName, `${ref.owner}/${ref.repo}`)));
    if (!row) {
      throw new Error(`repo local inconnu : ${ref.owner}/${ref.repo}`);
    }
    this.#paths.set(row.repo.fullName, row.path);
    return row;
  }

  /** Numéro suivant du repo, sous verrou : issues et demandes de merge partagent la suite. */
  async #nextNumber(tx: Tx, repoId: string): Promise<number> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`local:${repoId}`}))`);
    const [last] = await tx
      .select({ number: localItems.number })
      .from(localItems)
      .where(eq(localItems.repoId, repoId))
      .orderBy(desc(localItems.number))
      .limit(1);
    return (last?.number ?? 0) + 1;
  }

  getApp(): Promise<AppInfo> {
    // Les permissions sont celles exigées, ni plus ni moins : la vérification du démarrage passe.
    return Promise.resolve({
      slug: "jules-local",
      permissions: { ...REQUIRED_PERMISSIONS },
      events: [...REQUIRED_EVENTS],
    });
  }

  async *listDeliveries(): AsyncIterable<HookDelivery> {
    // Pas de webhooks en mode local : rien à rattraper.
  }

  redeliver(): Promise<void> {
    return Promise.resolve();
  }

  /** Une seule personne sur sa machine ; ses droits Jules restent appliqués par l'api et le worker. */
  getRepoRole(): Promise<RepoRole> {
    return Promise.resolve("admin");
  }

  async findIssueComment(ref: RepoRef, issueNumber: number, marker: string) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .select({ id: localComments.id })
      .from(localComments)
      .where(
        and(
          eq(localComments.repoId, repo.id),
          eq(localComments.number, issueNumber),
          eq(localComments.kind, "comment"),
          sql`strpos(${localComments.body}, ${marker}) > 0`,
        ),
      )
      .limit(1);
    return row;
  }

  async createIssueComment(ref: RepoRef, issueNumber: number, body: string) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .insert(localComments)
      .values({ orgId: repo.orgId, repoId: repo.id, number: issueNumber, kind: "comment", body })
      .returning({ id: localComments.id });
    return { id: row?.id ?? 0 };
  }

  async updateIssueComment(_ref: RepoRef, commentId: number, body: string): Promise<boolean> {
    const rows = await this.#db
      .update(localComments)
      .set({ body, updatedAt: sql`now()` })
      .where(eq(localComments.id, commentId))
      .returning({ id: localComments.id });
    return rows.length > 0;
  }

  /**
   * Le dossier local lui-même. Le worker demande toujours le jeton avant l'URL : `getRepoToken`
   * résout le chemin, et un repo ajouté après le démarrage est donc trouvé.
   */
  cloneUrl(ref: RepoRef): string {
    const path = this.#paths.get(`${ref.owner}/${ref.repo}`);
    if (!path) {
      throw new Error(`repo local inconnu : ${ref.owner}/${ref.repo}`);
    }
    return path;
  }

  /** Aucun jeton : git lit le dossier directement. La valeur n'est qu'un marqueur. */
  async getRepoToken(ref: RepoRef): Promise<string> {
    await this.#repo(ref);
    return "local";
  }

  #toPullRequest(row: typeof localItems.$inferSelect, repoName: string): PullRequest {
    return {
      number: row.number,
      url: `local:${repoName}#${row.number}`,
      draft: row.draft,
      nodeId: row.id,
    };
  }

  /** Comme sur GitHub, quel que soit son état : une demande déjà mergée n'est pas recréée. */
  async findPullRequest(ref: RepoRef, head: string) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .select()
      .from(localItems)
      .where(
        and(
          eq(localItems.repoId, repo.id),
          eq(localItems.kind, "merge_request"),
          eq(localItems.head, head),
        ),
      )
      .orderBy(desc(localItems.number))
      .limit(1);
    return row ? this.#toPullRequest(row, ref.repo) : undefined;
  }

  async createPullRequest(ref: RepoRef, pr: NewPullRequest): Promise<PullRequest> {
    const { repo } = await this.#repo(ref);
    const row = await this.#db.transaction(async (tx) => {
      const number = await this.#nextNumber(tx, repo.id);
      const [created] = await tx
        .insert(localItems)
        .values({
          orgId: repo.orgId,
          repoId: repo.id,
          number,
          kind: "merge_request",
          title: pr.title,
          body: pr.body,
          head: pr.head,
          base: pr.base,
          draft: pr.draft,
        })
        .returning();
      return created;
    });
    if (!row) {
      throw new Error("demande de merge non créée");
    }
    return this.#toPullRequest(row, ref.repo);
  }

  async updatePullRequest(ref: RepoRef, number: number, update: { title?: string; body?: string }) {
    const { repo } = await this.#repo(ref);
    await this.#db
      .update(localItems)
      .set({ ...update, updatedAt: sql`now()` })
      .where(and(eq(localItems.repoId, repo.id), eq(localItems.number, number)));
  }

  async markReadyForReview(ref: RepoRef, pr: PullRequest) {
    const { repo } = await this.#repo(ref);
    await this.#db
      .update(localItems)
      .set({ draft: false, updatedAt: sql`now()` })
      .where(and(eq(localItems.repoId, repo.id), eq(localItems.number, pr.number)));
  }

  async createReview(ref: RepoRef, number: number, review: NewReview) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .insert(localComments)
      .values({
        orgId: repo.orgId,
        repoId: repo.id,
        number,
        kind: "review",
        body: review.body,
        review: { commitId: review.commitId, comments: review.comments },
      })
      .returning({ id: localComments.id });
    return { id: row?.id ?? 0 };
  }

  async findReview(ref: RepoRef, number: number, marker: string) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .select({ id: localComments.id })
      .from(localComments)
      .where(
        and(
          eq(localComments.repoId, repo.id),
          eq(localComments.number, number),
          eq(localComments.kind, "review"),
          sql`strpos(${localComments.body}, ${marker}) > 0`,
        ),
      )
      .limit(1);
    return row;
  }

  async listReviewComments(_ref: RepoRef, _number: number, reviewId: number) {
    const [row] = await this.#db.select().from(localComments).where(eq(localComments.id, reviewId));
    const review = row?.review as
      { comments?: { path: string; line: number; body: string }[] } | null | undefined;
    return (review?.comments ?? []).map((c) => ({ path: c.path, line: c.line, body: c.body }));
  }

  /** Pas de rulesets en local : la branche de base n'est protégée que par le bouton humain. */
  getBranchRules(): Promise<{ type: string; parameters?: Record<string, unknown> }[]> {
    return Promise.resolve([]);
  }

  async createIssue(ref: RepoRef, issue: { title: string; body: string; labels?: string[] }) {
    const { repo } = await this.#repo(ref);
    const number = await this.#db.transaction(async (tx) => {
      const next = await this.#nextNumber(tx, repo.id);
      await tx.insert(localItems).values({
        orgId: repo.orgId,
        repoId: repo.id,
        number: next,
        kind: "issue",
        title: issue.title,
        body: issue.body,
        labels: issue.labels ?? [],
      });
      return next;
    });
    return { number };
  }

  async closeIssue(ref: RepoRef, issueNumber: number) {
    const { repo } = await this.#repo(ref);
    await this.#db
      .update(localItems)
      .set({ state: "closed", updatedAt: sql`now()` })
      .where(
        and(
          eq(localItems.repoId, repo.id),
          eq(localItems.number, issueNumber),
          eq(localItems.kind, "issue"),
        ),
      );
  }

  /** Pas d'onglet Security en local : les findings restent dans l'app. */
  uploadSarif(): Promise<{ id: string }> {
    return Promise.resolve({ id: "local" });
  }

  async findIssueByMarker(ref: RepoRef, marker: string) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .select({ number: localItems.number })
      .from(localItems)
      .where(
        and(
          eq(localItems.repoId, repo.id),
          eq(localItems.kind, "issue"),
          sql`strpos(${localItems.body}, ${marker}) > 0`,
        ),
      )
      .limit(1);
    return row;
  }

  async listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]> {
    const { repo } = await this.#repo(ref);
    const rows = await this.#db
      .select()
      .from(localChecks)
      .where(and(eq(localChecks.repoId, repo.id), eq(localChecks.sha, sha)));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status as CheckRun["status"],
      conclusion: r.conclusion,
      appId: 1,
    }));
  }

  async upsertCheckRun(ref: RepoRef, run: CheckRunInput) {
    const { repo } = await this.#repo(ref);
    const [row] = await this.#db
      .insert(localChecks)
      .values({
        orgId: repo.orgId,
        repoId: repo.id,
        sha: run.headSha,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion ?? null,
        title: run.title,
        summary: run.summary,
      })
      .onConflictDoUpdate({
        target: [localChecks.repoId, localChecks.sha, localChecks.name],
        set: {
          status: run.status,
          conclusion: run.conclusion ?? null,
          title: run.title,
          summary: run.summary,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: localChecks.id });
    return { id: row?.id ?? 0 };
  }

  /** Le suivi des déploiements reste dans la table `deployments` ; rien à publier en local. */
  createDeployment(): Promise<{ id: number }> {
    return Promise.resolve({ id: Date.now() });
  }

  createDeploymentStatus(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Merge humain d'une demande de merge dans la branche de base du dossier local. Le dossier de
   * travail de la personne n'est jamais écrasé : base extraite et propre, `git merge` ; base non
   * extraite, commit de merge construit à part puis branche avancée (compare-and-swap). `git` force
   * déjà ses options sûres : aucun hook, ni du dossier, ni versionné par l'agent, ne s'exécute.
   */
  async merge(ref: RepoRef, number: number, author: { login: string }): Promise<{ sha: string }> {
    const { repo, path } = await this.#repo(ref);
    const [item] = await this.#db
      .select()
      .from(localItems)
      .where(
        and(
          eq(localItems.repoId, repo.id),
          eq(localItems.number, number),
          eq(localItems.kind, "merge_request"),
        ),
      );
    if (!item?.head || item.state !== "open") {
      throw new LocalMergeError(`demande de merge !${number} introuvable ou déjà fermée`);
    }
    const head = item.head;
    const base = item.base ?? repo.defaultBranch ?? "main";
    const run = (args: string[]) => git(args, { cwd: path });
    const identity = [
      "-c",
      `user.name=${author.login}`,
      "-c",
      `user.email=${author.login}@users.jules.local`,
    ];
    const message = `Merge !${number} : ${item.title}`;
    const sha = async (branch: string) => {
      try {
        return (await run(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim();
      } catch {
        throw new LocalMergeError(`branche ${branch} absente du repo local`);
      }
    };
    const headSha = await sha(head);
    const baseSha = await sha(base);
    // Reprise après un crash : la base contient déjà la branche, rien à refaire.
    const done = await run(["merge-base", "--is-ancestor", headSha, baseSha]).then(
      () => true,
      () => false,
    );
    const current = (await run(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).trim();
    if (done) {
      // Rien : la branche de base est déjà à jour.
    } else if (current === `refs/heads/${base}`) {
      if ((await run(["status", "--porcelain", "--untracked-files=no"])).trim() !== "") {
        throw new LocalMergeError(
          `modifications non commitées sur ${base} : commite-les ou mets-les de côté, puis recommence`,
        );
      }
      try {
        await run([...identity, "merge", "--no-ff", "--no-edit", "-m", message, headSha]);
      } catch (error) {
        await run(["merge", "--abort"]).catch(() => "");
        throw new LocalMergeError(
          `merge impossible, à résoudre dans le repo local : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      const tree = await run(["merge-tree", "--write-tree", baseSha, headSha]).catch(() => {
        throw new LocalMergeError("conflit de merge : à résoudre dans le repo local");
      });
      const commit = (
        await run([
          ...identity,
          "commit-tree",
          tree.trim().split("\n")[0] ?? "",
          "-p",
          baseSha,
          "-p",
          headSha,
          "-m",
          message,
        ])
      ).trim();
      // Compare-and-swap : si la base a bougé entre-temps, rien n'est écrasé.
      await run(["update-ref", "-m", message, `refs/heads/${base}`, commit, baseSha]);
    }
    const merged = await sha(base);
    await this.#db.transaction(async (tx) => {
      await tx
        .update(localItems)
        .set({ state: "merged", mergeSha: merged, updatedAt: sql`now()` })
        .where(eq(localItems.id, item.id));
      // Comme GitHub : « Closes #12 » dans la description ferme l'issue au merge.
      const closes = [
        ...item.body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)/gi),
      ];
      for (const [, issue] of closes) {
        await tx
          .update(localItems)
          .set({ state: "closed", updatedAt: sql`now()` })
          .where(
            and(
              eq(localItems.repoId, repo.id),
              eq(localItems.number, Number(issue)),
              eq(localItems.kind, "issue"),
            ),
          );
      }
      // Comme un webhook GitHub : la suite du pipeline (bilan, audit, déploiement) n'a pas de cas à part.
      await tx
        .insert(events)
        .values({
          orgId: repo.orgId,
          deliveryId: `local-merge-${item.id}`,
          event: "pull_request",
          action: "closed",
          githubInstallationId: LOCAL_INSTALLATION_ID,
          payload: {
            action: "closed",
            installation: { id: LOCAL_INSTALLATION_ID },
            repository: {
              id: repo.githubRepoId,
              name: ref.repo,
              owner: { login: LOCAL_OWNER },
              default_branch: base,
            },
            sender: { id: 0, login: author.login, type: "User" },
            pull_request: {
              number,
              merged: true,
              merged_at: new Date().toISOString(),
              merge_commit_sha: merged,
              base: { ref: base },
            },
          },
        })
        .onConflictDoNothing();
    });
    return { sha: merged };
  }
}
