import { and, eq, isNull, or, stops, type DbOrTx } from "@jules/db";

// Arrêt d'urgence (ARCHITECTURE.md §17) : global, par repo ou par serveur.

export async function isStopped(
  db: DbOrTx,
  orgId: string,
  target?: { repoId?: string },
): Promise<boolean> {
  const scopes = [eq(stops.scope, "global")];
  if (target?.repoId) {
    const repoScope = and(eq(stops.scope, "repo"), eq(stops.targetId, target.repoId));
    if (repoScope) {
      scopes.push(repoScope);
    }
  }
  const [active] = await db
    .select({ id: stops.id })
    .from(stops)
    .where(and(eq(stops.orgId, orgId), isNull(stops.liftedAt), or(...scopes)))
    .limit(1);
  return active !== undefined;
}
