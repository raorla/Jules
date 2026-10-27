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

type TaskOverrides = {
  issueNumber?: number;
  state?: "received" | "building";
  autonomy?: "L0" | "L1" | "L2";
  title?: string;
  request?: string;
  /** Mode local (M10) : la tâche porte sur ce dossier git, par la forge locale. */
  localPath?: string;
};

/** Une tâche prête à exécuter, sur un repo et une installation de test. */
export async function seedTask(db: Db, overrides: TaskOverrides = {}) {
  const { installations, repos, registerLocalRepo } = await import("@jules/db");
  if (overrides.localPath) {
    const repo = await registerLocalRepo(db, { orgId: DEFAULT_ORG_ID, path: overrides.localPath });
    return { repo, task: await insertTask(db, repo.id, overrides) };
  }
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
  return {
    installation: installation!,
    repo: repo!,
    task: await insertTask(db, repo!.id, overrides),
  };
}

async function insertTask(db: Db, repoId: string, overrides: TaskOverrides) {
  const { tasks } = await import("@jules/db");
  const [task] = await db
    .insert(tasks)
    .values({
      orgId: DEFAULT_ORG_ID,
      repoId,
      agent: "developer",
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 1e6),
      title: overrides.title ?? "Ajouter /healthz",
      request: overrides.request ?? "@jules ajoute un endpoint /healthz",
      // Par défaut, une tâche déjà en développement (raccourci des tests de M1) ; `received` pour tout le pipeline.
      state: overrides.state ?? "building",
      ...(overrides.state === "received"
        ? {}
        : {
            autonomy: "L2" as const,
            type: "bug",
            size: "S",
            risk: "low" as const,
            language: "fr" as const,
          }),
      ...(overrides.autonomy ? { autonomy: overrides.autonomy } : {}),
    })
    .returning();
  return task!;
}
