import { appendAudit } from "@jules/audit";
import { and, eq, isNull, runs, sql, stops, type Db } from "@jules/db";
import type { SandboxDriver } from "@jules/sandbox";

// Arrêt d'urgence (ARCHITECTURE.md §17) : `jules stop --all` marche même si l'api est tombée.
// 1. il bloque tout nouveau démarrage (ligne active dans `stops`) ;
// 2. il révoque tous les jetons d'exécution ;
// 3. il tue tous les sandboxes et egress proxies.
// Les demandes d'approbation en cours (M2) et les environnements (M7) s'ajouteront ici.

export type StopReport = { revokedTokens: number; killedContainers: number };

export async function stopAll(
  db: Db,
  driver: Pick<SandboxDriver, "stopAll">,
  options: { orgId: string; reason: string; actorId: string },
): Promise<StopReport> {
  const revoked = await db.transaction(async (tx) => {
    await tx.insert(stops).values({
      orgId: options.orgId,
      scope: "global",
      reason: options.reason,
      setBy: options.actorId,
    });
    const rows = await tx
      .update(runs)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(runs.orgId, options.orgId), isNull(runs.revokedAt)))
      .returning({ id: runs.id });
    await appendAudit(tx, {
      orgId: options.orgId,
      actor: { type: "system", id: options.actorId },
      action: "stop.all",
      target: { type: "org", id: options.orgId },
      data: { revokedTokens: rows.length },
    });
    return rows.length;
  });
  const killedContainers = await driver.stopAll();
  return { revokedTokens: revoked, killedContainers };
}

/** Lève l'arrêt d'urgence. Depuis l'interface, il faudra une passkey (M6) ; ici, l'accès au serveur fait foi. */
export async function liftStop(
  db: Db,
  options: { orgId: string; actorId: string },
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(stops)
      .set({ liftedAt: sql`now()`, liftedBy: options.actorId })
      .where(and(eq(stops.orgId, options.orgId), isNull(stops.liftedAt)))
      .returning({ id: stops.id });
    await appendAudit(tx, {
      orgId: options.orgId,
      actor: { type: "system", id: options.actorId },
      action: "stop.lifted",
      target: { type: "org", id: options.orgId },
      data: { lifted: rows.length },
    });
    return rows.length;
  });
}
