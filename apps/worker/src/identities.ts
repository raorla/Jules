import { installations, repos, sql, users, type Tx } from "@jules/db";
import type { TaskTrigger } from "./triggers.js";

// Installations, repos et personnes vus dans les webhooks. Les logins restent dans `users` :
// l'audit ne porte que les identifiants internes (ARCHITECTURE.md §18).

export function returned<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`${what} : aucune ligne renvoyée`);
  }
  return row;
}

export async function upsertInstallation(
  tx: Tx,
  orgId: string,
  values: { githubInstallationId: number; accountLogin: string; accountType: string },
): Promise<string> {
  const rows = await tx
    .insert(installations)
    .values({ orgId, ...values })
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { accountLogin: values.accountLogin, updatedAt: sql`now()` },
    })
    .returning({ id: installations.id });
  return returned(rows, "installation").id;
}

export async function upsertRepo(
  tx: Tx,
  orgId: string,
  installationId: string,
  repo: TaskTrigger["repo"],
) {
  const rows = await tx
    .insert(repos)
    .values({
      orgId,
      forge: "github",
      installationId,
      githubRepoId: repo.githubId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
    })
    .onConflictDoUpdate({
      target: [repos.forge, repos.githubRepoId],
      set: {
        installationId,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: repos.id });
  return returned(rows, "repo").id;
}

export async function upsertUser(
  tx: Tx,
  orgId: string,
  sender: TaskTrigger["sender"],
): Promise<string> {
  const rows = await tx
    .insert(users)
    .values({ orgId, githubUserId: sender.githubId, login: sender.login, kind: "human" })
    .onConflictDoUpdate({
      target: [users.orgId, users.githubUserId],
      set: { login: sender.login, updatedAt: sql`now()` },
    })
    .returning({ id: users.id });
  return returned(rows, "user").id;
}
