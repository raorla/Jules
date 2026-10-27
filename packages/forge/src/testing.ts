import { randomUUID } from "node:crypto";
import { REQUIRED_EVENTS, REQUIRED_PERMISSIONS, type AppInfo } from "./app-setup.js";
import type { GitHubApp, HookDelivery, RepoRef, RepoRole } from "./github.js";
import { signWebhook } from "./webhooks.js";

// GitHub en mémoire pour les tests : livre de vrais webhooks signés en HTTP, garde l'historique
// des livraisons (comme l'onglet « Advanced » de l'App) et les commentaires des issues.

type StoredDelivery = HookDelivery & { readonly payload: string };

export type FakeComment = {
  readonly id: number;
  readonly issueKey: string;
  body: string;
  readonly byApp: boolean;
};

export class FakeGitHub implements GitHubApp {
  readonly comments: FakeComment[] = [];
  /** Configuration de l'App, conforme par défaut ; un test peut la modifier. */
  app: AppInfo = {
    slug: "jules",
    permissions: { ...REQUIRED_PERMISSIONS },
    events: [...REQUIRED_EVENTS],
  };
  readonly #deliveries: StoredDelivery[] = [];
  readonly #roles = new Map<string, RepoRole>();
  readonly #failures = new Map<keyof GitHubApp, number>();
  #nextId = 1000;

  constructor(private readonly webhook: { url: string; secret: string }) {}

  setRole(username: string, role: RepoRole): void {
    this.#roles.set(username, role);
  }

  /** Fait échouer les `times` prochains appels à `method`, comme une panne de l'API GitHub. */
  failNext(method: keyof GitHubApp, times = 1): void {
    this.#failures.set(method, times);
  }

  #maybeFail(method: keyof GitHubApp): void {
    const remaining = this.#failures.get(method) ?? 0;
    if (remaining > 0) {
      this.#failures.set(method, remaining - 1);
      throw Object.assign(new Error(`GitHub indisponible (${method})`), { status: 503 });
    }
  }

  get deliveries(): readonly HookDelivery[] {
    return this.#deliveries;
  }

  /** Envoie un webhook comme GitHub ; une livraison échouée reste dans l'historique. */
  async deliver(
    event: string,
    payload: object,
    guid: string = randomUUID(),
  ): Promise<HookDelivery> {
    return this.#send(event, JSON.stringify(payload), guid, false);
  }

  async #send(
    event: string,
    body: string,
    guid: string,
    redelivery: boolean,
  ): Promise<HookDelivery> {
    let statusCode: number;
    try {
      const response = await fetch(this.webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "GitHub-Hookshot/fake",
          "x-github-event": event,
          "x-github-delivery": guid,
          "x-hub-signature-256": signWebhook(this.webhook.secret, body),
        },
        body,
      });
      statusCode = response.status;
    } catch {
      statusCode = 502;
    }
    const parsed = JSON.parse(body) as { installation?: { id: number } };
    const delivery: StoredDelivery = {
      id: this.#nextId++,
      guid,
      deliveredAt: new Date(),
      redelivery,
      statusCode,
      event,
      installationId: parsed.installation?.id ?? null,
      payload: body,
    };
    this.#deliveries.unshift(delivery);
    return delivery;
  }

  getApp(): Promise<AppInfo> {
    return Promise.resolve(this.app);
  }

  async *listDeliveries(): AsyncIterable<HookDelivery> {
    this.#maybeFail("listDeliveries");
    await Promise.resolve();
    yield* [...this.#deliveries];
  }

  async redeliver(deliveryId: number): Promise<void> {
    this.#maybeFail("redeliver");
    const original = this.#deliveries.find((d) => d.id === deliveryId);
    if (!original) {
      throw new Error(`livraison ${deliveryId} inconnue`);
    }
    await this.#send(original.event, original.payload, original.guid, true);
  }

  async getRepoRole(_ref: RepoRef, username: string): Promise<RepoRole> {
    this.#maybeFail("getRepoRole");
    await Promise.resolve();
    return this.#roles.get(username) ?? "none";
  }

  findIssueComment(ref: RepoRef, issueNumber: number, marker: string) {
    const key = issueKey(ref, issueNumber);
    const found = this.comments.find(
      (c) => c.issueKey === key && c.byApp && c.body.includes(marker),
    );
    return Promise.resolve(found ? { id: found.id } : undefined);
  }

  async createIssueComment(ref: RepoRef, issueNumber: number, body: string) {
    this.#maybeFail("createIssueComment");
    await Promise.resolve();
    const comment = { id: this.#nextId++, issueKey: issueKey(ref, issueNumber), body, byApp: true };
    this.comments.push(comment);
    return { id: comment.id };
  }

  updateIssueComment(_ref: RepoRef, commentId: number, body: string) {
    const comment = this.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.body = body;
    }
    return Promise.resolve(comment !== undefined);
  }

  /** Commentaire laissé par une personne (par exemple pour tenter de recopier un marqueur). */
  addHumanComment(ref: RepoRef, issueNumber: number, body: string): void {
    this.comments.push({
      id: this.#nextId++,
      issueKey: issueKey(ref, issueNumber),
      body,
      byApp: false,
    });
  }

  commentsOn(ref: RepoRef, issueNumber: number): FakeComment[] {
    return this.comments.filter((c) => c.issueKey === issueKey(ref, issueNumber));
  }
}

const issueKey = (ref: RepoRef, issueNumber: number) => `${ref.owner}/${ref.repo}#${issueNumber}`;
