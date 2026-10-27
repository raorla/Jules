import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "./client.js";
import { installations, localRepos, repos } from "./schema.js";

// Mode local (M10, ARCHITECTURE.md §4.7, §11) : un dossier git de la machine tient lieu de repo.
// Il passe par les mêmes tables que GitHub, sous une installation fictive, pour que le worker n'ait
// aucun cas à part.

/** Installation fictive des repos locaux ; aucun identifiant GitHub n'est nul ni négatif. */
export const LOCAL_INSTALLATION_ID = 0;
export const LOCAL_OWNER = "local";

/** Nom d'un dossier comme nom de repo : lettres, chiffres, `.`, `_` et `-`. */
export function localRepoName(path: string): string {
  const base =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? "";
  return base.replace(/[^\w.-]/g, "-").replace(/^[.-]+/, "") || "repo";
}

/**
 * Enregistre un dossier local (ou retrouve celui déjà enregistré). Les repos locaux reçoivent un
 * identifiant négatif : il ne croise jamais celui d'un repo GitHub, toujours positif.
 */
export function registerLocalRepo(
  db: DbOrTx,
  input: { orgId: string; path: string; defaultBranch?: string | undefined },
) {
  return db.transaction((tx) => register(tx, input));
}

async function register(
  db: Tx,
  input: { orgId: string; path: string; defaultBranch?: string | undefined },
) {
  // Verrou d'abord : deux enregistrements simultanés du même dossier ne créent qu'un repo.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('jules:local-repos'))`);
  const [existing] = await db
    .select({ repo: repos })
    .from(localRepos)
    .innerJoin(repos, eq(repos.id, localRepos.repoId))
    .where(and(eq(localRepos.orgId, input.orgId), eq(localRepos.path, input.path)));
  if (existing) {
    return existing.repo;
  }
  const [installation] = await db
    .insert(installations)
    .values({
      orgId: input.orgId,
      githubInstallationId: LOCAL_INSTALLATION_ID,
      accountLogin: LOCAL_OWNER,
      accountType: "Local",
    })
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { accountLogin: LOCAL_OWNER },
    })
    .returning({ id: installations.id });
  const taken = await db
    .select({ fullName: repos.fullName, githubRepoId: repos.githubRepoId })
    .from(repos)
    .where(eq(repos.forge, "local"));
  const names = new Set(taken.map((r) => r.fullName));
  const base = localRepoName(input.path);
  let name = base;
  for (let n = 2; names.has(`${LOCAL_OWNER}/${name}`); n++) {
    name = `${base}-${n}`;
  }
  const lowest = Math.min(0, ...taken.map((r) => r.githubRepoId ?? 0));
  const [repo] = await db
    .insert(repos)
    .values({
      orgId: input.orgId,
      forge: "local",
      installationId: installation?.id,
      githubRepoId: lowest - 1,
      fullName: `${LOCAL_OWNER}/${name}`,
      defaultBranch: input.defaultBranch ?? "main",
      // Rien ne sort de la machine : aucune issue publique ne peut divulguer une faille.
      private: true,
    })
    .returning();
  if (!repo) {
    throw new Error("repo local non créé");
  }
  await db.insert(localRepos).values({ orgId: input.orgId, repoId: repo.id, path: input.path });
  return repo;
}
