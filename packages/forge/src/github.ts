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
}

export type PullRequest = {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
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
    return pr ? { number: pr.number, url: pr.html_url, draft: pr.draft ?? false } : undefined;
  }

  async createPullRequest(ref: RepoRef, pr: NewPullRequest): Promise<PullRequest> {
    const octokit = await this.#installation(ref, { pull_requests: "write" });
    const { data } = await octokit.rest.pulls.create({ owner: ref.owner, repo: ref.repo, ...pr });
    return { number: data.number, url: data.html_url, draft: data.draft ?? false };
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
