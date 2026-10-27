import { DEFAULT_ORG_ID, events, type Db } from "@jules/db";
import type { GitHubApp } from "@jules/forge";
import pino from "pino";
import type { WorkerDeps } from "../src/deps.js";

export function testDeps(db: Db, github: GitHubApp): WorkerDeps {
  return {
    db,
    github,
    log: pino({ level: "silent" }),
    settings: { mention: "@jules", label: "jules", language: "fr" },
  };
}

/** Comme le gateway : un webhook déjà vérifié, stocké tel quel. */
export async function storeEvent(db: Db, event: string, payload: { action?: string }) {
  const [row] = await db
    .insert(events)
    .values({
      orgId: DEFAULT_ORG_ID,
      deliveryId: crypto.randomUUID(),
      event,
      action: payload.action ?? null,
      githubInstallationId: 4242,
      payload,
    })
    .returning();
  return row!;
}

export async function eventually<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("condition jamais atteinte");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Une tâche prête à exécuter, sur un repo et une installation de test. */
export async function seedTask(db: Db, overrides: { issueNumber?: number } = {}) {
  const { installations, repos, tasks } = await import("@jules/db");
  const [installation] = await db
    .insert(installations)
    .values({
      orgId: DEFAULT_ORG_ID,
      githubInstallationId: 4242,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { accountLogin: "acme" },
    })
    .returning();
  const [repo] = await db
    .insert(repos)
    .values({
      orgId: DEFAULT_ORG_ID,
      forge: "github",
      installationId: installation!.id,
      githubRepoId: 99,
      fullName: "acme/sandbox",
      defaultBranch: "main",
      private: true,
    })
    .onConflictDoUpdate({
      target: [repos.forge, repos.githubRepoId],
      set: { fullName: "acme/sandbox" },
    })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      agent: "developer",
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 1e6),
      title: "Ajouter /healthz",
      request: "@jules ajoute un endpoint /healthz",
    })
    .returning();
  return { installation: installation!, repo: repo!, task: task! };
}
