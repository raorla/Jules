import { gzipSync } from "node:zlib";
import { App, Octokit } from "octokit";
import type { AppInfo } from "./app-setup.js";

// Accès à GitHub pour le worker (ARCHITECTURE.md §11, §12). Seul le worker détient la clé de l'App.
// Chaque opération demande un jeton d'installation limité au repo et aux permissions qu'elle utilise (§5).

export type RepoRef = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
};

/** Rôle effectif d'une personne sur un repo, du plus fort au plus faible. */
export const REPO_ROLES = ["admin", "maintain", "write", "triage", "read", "none"] as const;
export type RepoRole = (typeof REPO_ROLES)[number];

export function hasAtLeast(role: RepoRole, required: RepoRole): boolean {
  return REPO_ROLES.indexOf(role) <= REPO_ROLES.indexOf(required);
}

export type HookDelivery = {
  readonly id: number;
  readonly guid: string;
  readonly deliveredAt: Date;
  readonly redelivery: boolean;
  readonly statusCode: number;
  readonly event: string;
  readonly installationId: number | null;
};

export interface GitHubApp {
  /** Nom, permissions et événements de l'App, tels que GitHub les applique. */
  getApp(): Promise<AppInfo>;
  /** Livraisons de webhooks de l'App, de la plus récente à la plus ancienne. */
  listDeliveries(): AsyncIterable<HookDelivery>;
  redeliver(deliveryId: number): Promise<void>;
  getRepoRole(ref: RepoRef, username: string): Promise<RepoRole>;
  /** Commentaire de l'App qui contient `marker`, s'il existe. Les commentaires des autres sont ignorés. */
  findIssueComment(
    ref: RepoRef,
    issueNumber: number,
    marker: string,
  ): Promise<{ id: number } | undefined>;
  createIssueComment(ref: RepoRef, issueNumber: number, body: string): Promise<{ id: number }>;
  /** `false` si le commentaire n'existe plus. */
  updateIssueComment(ref: RepoRef, commentId: number, body: string): Promise<boolean>;
  /** URL de clone, sans identifiant : le jeton passe par GIT_ASKPASS. */
  cloneUrl(ref: RepoRef): string;
  /** Jeton d'installation limité à ce repo et à ces permissions. Il reste dans la mémoire du worker. */
  getRepoToken(ref: RepoRef, permissions: Permissions): Promise<string>;
  findPullRequest(ref: RepoRef, head: string): Promise<PullRequest | undefined>;
  createPullRequest(ref: RepoRef, pr: NewPullRequest): Promise<PullRequest>;
  updatePullRequest(
    ref: RepoRef,
    number: number,
    update: { title?: string; body?: string },
  ): Promise<void>;
  /** Passe une PR brouillon en « ready for review » ; GitHub demande alors les reviewers CODEOWNERS. */
  markReadyForReview(ref: RepoRef, pr: PullRequest): Promise<void>;
  /** Review de type COMMENT (jamais APPROVE) : l'avis de Jules ne compte pas dans les approbations requises. */
  createReview(ref: RepoRef, number: number, review: NewReview): Promise<{ id: number }>;
  /** Review de l'App qui contient `marker`, si elle existe. */
  findReview(ref: RepoRef, number: number, marker: string): Promise<{ id: number } | undefined>;
  listReviewComments(
    ref: RepoRef,
    number: number,
    reviewId: number,
  ): Promise<{ path: string; line: number | null; body: string }[]>;
  /** Règles actives sur une branche (rulesets) ; lisibles avec la seule permission Metadata. */
  getBranchRules(
    ref: RepoRef,
    branch: string,
  ): Promise<{ type: string; parameters?: Record<string, unknown> }[]>;
  createIssue(
    ref: RepoRef,
    issue: { title: string; body: string; labels?: string[] },
  ): Promise<{ number: number }>;
  closeIssue(ref: RepoRef, issueNumber: number): Promise<void>;
  /** Failles du code en SARIF dans l'onglet Security (permission `security_events`, repos privés). */
  uploadSarif(
    ref: RepoRef,
    upload: { commitSha: string; ref: string; sarif: string },
  ): Promise<{ id: string }>;
  /** Issue récente de l'App qui contient `marker` (création idempotente après un crash). */
  findIssueByMarker(ref: RepoRef, marker: string): Promise<{ number: number } | undefined>;
  /** Check runs d'un commit (la CI du projet, et ceux de Jules). */
  listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]>;
  /** Crée ou met à jour le check run `name` de ce commit. */
  upsertCheckRun(ref: RepoRef, run: CheckRunInput): Promise<{ id: number }>;
  /** Déploiement GitHub d'un commit (API Deployments, WORKFLOW.md §12.2). */
  createDeployment(ref: RepoRef, deployment: NewDeployment): Promise<{ id: number }>;
  createDeploymentStatus(ref: RepoRef, id: number, status: DeploymentStatusInput): Promise<void>;
}

export type NewDeployment = {
  sha: string;
  environment: string;
  description: string;
  productionEnvironment: boolean;
};

export type DeploymentStatusInput = {
  state: "queued" | "in_progress" | "success" | "failure" | "error" | "inactive";
  description: string;
  logUrl?: string;
};

export type NewReview = {
  commitId: string;
  body: string;
  comments: { path: string; line: number; body: string }[];
};

export type CheckRun = {
  readonly id: number;
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  readonly conclusion: string | null;
  readonly appId: number | null;
};

export type CheckRunInput = {
  name: string;
  headSha: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "action_required";
  title: string;
  summary: string;
};

export type PullRequest = {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
  /** Identifiant GraphQL, pour passer la PR en « ready ». */
  readonly nodeId: string;
};
export type NewPullRequest = {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};

export type Permissions = Record<string, "read" | "write">;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export class OctokitGitHubApp implements GitHubApp {
  readonly #app: App;
  readonly #appId: number;

  constructor(options: { appId: number; privateKey: string }) {
    this.#appId = options.appId;
    this.#app = new App({ appId: options.appId, privateKey: options.privateKey });
  }

  async getRepoToken(ref: RepoRef, permissions: Permissions): Promise<string> {
    const auth = (await this.#app.octokit.auth({
      type: "installation",
      installationId: ref.installationId,
      repositoryNames: [ref.repo],
      permissions,
    })) as { token: string };
    return auth.token;
  }

  async #installation(ref: RepoRef, permissions: Permissions): Promise<Octokit> {
    return new Octokit({ auth: await this.getRepoToken(ref, permissions) });
  }

  cloneUrl(ref: RepoRef): string {
    return `https://github.com/${ref.owner}/${ref.repo}.git`;
  }

  async findPullRequest(ref: RepoRef, head: string): Promise<PullRequest | undefined> {
    const octokit = await this.#installation(ref, { pull_requests: "read" });
    const { data } = await octokit.rest.pulls.list({
      owner: ref.owner,
      repo: ref.repo,
      head: `${ref.owner}:${head}`,
      state: "all",
      per_page: 10,
    });
    const pr = data[0];
    return pr
      ? { number: pr.number, url: pr.html_url, draft: pr.draft ?? false, nodeId: pr.node_id }
      : undefined;
  }

  async listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]> {
    const octokit = await this.#installation(ref, { checks: "read" });
    const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
      owner: ref.owner,
      repo: ref.repo,
      ref: sha,
      per_page: 100,
    });
    return runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      appId: r.app?.id ?? null,
    }));
  }

  async upsertCheckRun(ref: RepoRef, run: CheckRunInput): Promise<{ id: number }> {
    const octokit = await this.#installation(ref, { checks: "write" });
    const output = { title: run.title, summary: run.summary.slice(0, 65_000) };
    const existing = (await this.listCheckRuns(ref, run.headSha)).find(
      (r) => r.name === run.name && r.appId === this.#appId,
    );
    const body = {
      status: run.status,
      output,
      ...(run.conclusion ? { conclusion: run.conclusion } : {}),
    };
    if (existing) {
      await octokit.rest.checks.update({
        owner: ref.owner,
        repo: ref.repo,
        check_run_id: existing.id,
        ...body,
      });
      return { id: existing.id };
    }
    const { data } = await octokit.rest.checks.create({
      owner: ref.owner,
      repo: ref.repo,
      name: run.name,
      head_sha: run.headSha,
      ...body,
    });
    return { id: data.id };
  }

  async createDeployment(ref: RepoRef, deployment: NewDeployment): Promise<{ id: number }> {
    const octokit = await this.#installation(ref, { deployments: "write" });
    const { data } = await octokit.rest.repos.createDeployment({
      owner: ref.owner,
      repo: ref.repo,
      ref: deployment.sha,
      environment: deployment.environment,
      description: deployment.description.slice(0, 140),
      production_environment: deployment.productionEnvironment,
      // La CI est déjà vérifiée par Jules ; sans cela GitHub exigerait des statuts de commit.
      required_contexts: [],
      auto_merge: false,
    });
    if (!("id" in data)) {
      throw new Error(`déploiement refusé par GitHub : ${data.message ?? "raison inconnue"}`);
    }
    return { id: data.id };
  }

  async createDeploymentStatus(
    ref: RepoRef,
    id: number,
    status: DeploymentStatusInput,
  ): Promise<void> {
    const octokit = await this.#installation(ref, { deployments: "write" });
    await octokit.rest.repos.createDeploymentStatus({
      owner: ref.owner,
      repo: ref.repo,
      deployment_id: id,
      state: status.state,
      description: status.description.slice(0, 140),
      ...(status.logUrl ? { log_url: status.logUrl } : {}),
    });
  }

  async createPullRequest(ref: RepoRef, pr: NewPullRequest): Promise<PullRequest> {
    const octokit = await this.#installation(ref, { pull_requests: "write" });
    const { data } = await octokit.rest.pulls.create({ owner: ref.owner, repo: ref.repo, ...pr });
    return {
      number: data.number,
      url: data.html_url,
      draft: data.draft ?? false,
      nodeId: data.node_id,
    };
  }

  async updatePullRequest(
    ref: RepoRef,
    number: number,
    update: { title?: string; body?: string },
  ): Promise<void> {
    const octokit = await this.#installation(ref, { pull_requests: "write" });
    await octokit.rest.pulls.update({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      ...update,
    });
  }

  async createIssue(
    ref: RepoRef,
    issue: { title: string; body: string; labels?: string[] },
  ): Promise<{ number: number }> {
    const octokit = await this.#installation(ref, { issues: "write" });
    const { data } = await octokit.rest.issues.create({
      owner: ref.owner,
      repo: ref.repo,
      title: issue.title,
      body: issue.body,
      ...(issue.labels ? { labels: issue.labels } : {}),
    });
    return { number: data.number };
  }

  async closeIssue(ref: RepoRef, issueNumber: number): Promise<void> {
    const octokit = await this.#installation(ref, { issues: "write" });
    await octokit.rest.issues.update({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      state: "closed",
      state_reason: "completed",
    });
  }

  async uploadSarif(
    ref: RepoRef,
    upload: { commitSha: string; ref: string; sarif: string },
  ): Promise<{ id: string }> {
    const octokit = await this.#installation(ref, { security_events: "write" });
    const { data } = await octokit.rest.codeScanning.uploadSarif({
      owner: ref.owner,
      repo: ref.repo,
      commit_sha: upload.commitSha,
      ref: upload.ref,
      // GitHub attend le SARIF compressé (gzip) puis encodé en base64.
      sarif: gzipSync(upload.sarif).toString("base64"),
      tool_name: "Jules",
    });
    return { id: data.id ?? "" };
  }

  async findIssueByMarker(ref: RepoRef, marker: string): Promise<{ number: number } | undefined> {
    const octokit = await this.#installation(ref, { issues: "read" });
    const { data } = await octokit.rest.issues.listForRepo({
      owner: ref.owner,
      repo: ref.repo,
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: 100,
    });
    const found = data.find(
      (i) => i.performed_via_github_app?.id === this.#appId && (i.body ?? "").includes(marker),
    );
    return found ? { number: found.number } : undefined;
  }

  async markReadyForReview(ref: RepoRef, pr: PullRequest): Promise<void> {
    if (!pr.draft) {
      return;
    }
    const octokit = await this.#installation(ref, { pull_requests: "write" });
    await octokit.graphql(
      "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
      { id: pr.nodeId },
    );
  }

  async createReview(ref: RepoRef, number: number, review: NewReview): Promise<{ id: number }> {
    const octokit = await this.#installation(ref, { pull_requests: "write" });
    const base = {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      commit_id: review.commitId,
      event: "COMMENT" as const,
    };
    try {
      const { data } = await octokit.rest.pulls.createReview({
        ...base,
        body: review.body,
        comments: review.comments.map((c) => ({ ...c, side: "RIGHT" as const })),
      });
      return { id: data.id };
    } catch (error) {
      // Une ligne hors du diff rend toute la review invalide (422) : on replie les commentaires dans le corps.
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 422 &&
        review.comments.length > 0
      ) {
        const folded = review.comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
        const { data } = await octokit.rest.pulls.createReview({
          ...base,
          body: `${review.body}\n\n${folded}`,
        });
        return { id: data.id };
      }
      throw error;
    }
  }

  async findReview(
    ref: RepoRef,
    number: number,
    marker: string,
  ): Promise<{ id: number } | undefined> {
    const octokit = await this.#installation(ref, { pull_requests: "read" });
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      per_page: 100,
    });
    const found = reviews.find((r) => r.body.includes(marker) && r.user?.type === "Bot");
    return found ? { id: found.id } : undefined;
  }

  async listReviewComments(ref: RepoRef, number: number, reviewId: number) {
    const octokit = await this.#installation(ref, { pull_requests: "read" });
    const comments = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      review_id: reviewId,
      per_page: 100,
    });
    return comments.map((c) => ({ path: c.path, line: c.line ?? null, body: c.body }));
  }

  async getBranchRules(ref: RepoRef, branch: string) {
    const octokit = await this.#installation(ref, { metadata: "read" });
    const { data } = await octokit.rest.repos.getBranchRules({
      owner: ref.owner,
      repo: ref.repo,
      branch,
      per_page: 100,
    });
    return data.map((r) => ({
      type: r.type,
      ...("parameters" in r && r.parameters ? { parameters: r.parameters } : {}),
    }));
  }

  async getApp(): Promise<AppInfo> {
    const { data } = await this.#app.octokit.rest.apps.getAuthenticated();
    if (!data) {
      throw new Error("GitHub n'a pas renvoyé les informations de l'App");
    }
    return {
      slug: data.slug ?? String(data.id),
      permissions: data.permissions,
      events: data.events,
    };
  }

  async *listDeliveries(): AsyncIterable<HookDelivery> {
    const pages = this.#app.octokit.paginate.iterator(
      this.#app.octokit.rest.apps.listWebhookDeliveries,
      {
        per_page: 100,
      },
    );
    for await (const page of pages) {
      for (const d of page.data) {
        yield {
          id: d.id,
          guid: d.guid,
          deliveredAt: new Date(d.delivered_at),
          redelivery: d.redelivery,
          statusCode: d.status_code,
          event: d.event,
          installationId: d.installation_id,
        };
      }
    }
  }

  async redeliver(deliveryId: number): Promise<void> {
    await this.#app.octokit.rest.apps.redeliverWebhookDelivery({ delivery_id: deliveryId });
  }

  async getRepoRole(ref: RepoRef, username: string): Promise<RepoRole> {
    const octokit = await this.#installation(ref, { metadata: "read" });
    try {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: ref.owner,
        repo: ref.repo,
        username,
      });
      // role_name peut être un rôle personnalisé : on retombe alors sur la permission de base.
      const role = (REPO_ROLES as readonly string[]).includes(data.role_name)
        ? (data.role_name as RepoRole)
        : (REPO_ROLES as readonly string[]).includes(data.permission)
          ? (data.permission as RepoRole)
          : "none";
      return role;
    } catch (error) {
      if (isNotFound(error)) {
        return "none";
      }
      throw error;
    }
  }

  async findIssueComment(ref: RepoRef, issueNumber: number, marker: string) {
    const octokit = await this.#installation(ref, { issues: "read" });
    const comments = octokit.paginate.iterator(octokit.rest.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    for await (const page of comments) {
      const found = page.data.find(
        (c) => c.performed_via_github_app?.id === this.#appId && c.body?.includes(marker) === true,
      );
      if (found) {
        return { id: found.id };
      }
    }
    return undefined;
  }

  async createIssueComment(ref: RepoRef, issueNumber: number, body: string) {
    const octokit = await this.#installation(ref, { issues: "write" });
    const { data } = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      body,
    });
    return { id: data.id };
  }

  async updateIssueComment(ref: RepoRef, commentId: number, body: string) {
    const octokit = await this.#installation(ref, { issues: "write" });
    try {
      await octokit.rest.issues.updateComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: commentId,
        body,
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }
}
