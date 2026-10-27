import { and, asc, auditLog, desc, eq, gt, sql, type Db, type DbOrTx } from "@jules/db";
import {
  GENESIS_HASH,
  assertNoPersonalData,
  hashEntry,
  type ActorType,
  type JsonValue,
} from "./chain.js";

export type AuditEntry = {
  orgId: string;
  /** Identifiant interne (users.id, nom du composant…), jamais un login ni un e-mail. */
  actor: { type: ActorType; id: string };
  action: string;
  target?: { type: string; id: string };
  data?: Record<string, JsonValue>;
};

export type AppendedEntry = { seq: number; hash: string };

const AUDIT_LOCK_CLASS = 7243;

/**
 * Ajoute une ligne au journal. À appeler dans la transaction du changement qu'elle décrit :
 * le verrou consultatif sérialise les ajouts d'une organisation jusqu'au commit.
 */
export async function appendAudit(db: DbOrTx, entry: AuditEntry): Promise<AppendedEntry> {
  // Normalise comme le fera jsonb (clés à undefined retirées), pour hasher ce qui sera relu.
  const data = JSON.parse(JSON.stringify(entry.data ?? {})) as JsonValue;
  assertNoPersonalData(data);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${AUDIT_LOCK_CLASS}, hashtext(${entry.orgId}))`,
    );
    const [last] = await tx
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.orgId, entry.orgId))
      .orderBy(desc(auditLog.seq))
      .limit(1);

    const fields = {
      orgId: entry.orgId,
      seq: (last?.seq ?? 0) + 1,
      at: new Date(),
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      action: entry.action,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      data,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const hash = hashEntry(fields);
    await tx.insert(auditLog).values({ ...fields, hash });
    return { seq: fields.seq, hash };
  });
}

export type ChainVerification =
  | { ok: true; checked: number; headHash: string }
  | { ok: false; checked: number; seq: number; reason: string };

/**
 * Recalcule la chaîne d'une organisation. Détecte une ligne modifiée, supprimée ou insérée.
 * Une troncature de la fin de la chaîne ne se voit qu'en comparant `headHash` à une valeur
 * conservée ailleurs.
 */
export async function verifyAuditChain(
  db: Db,
  orgId: string,
  options: { batchSize?: number } = {},
): Promise<ChainVerification> {
  const batchSize = options.batchSize ?? 1000;
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  let checked = 0;

  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), gt(auditLog.seq, expectedSeq - 1)))
      .orderBy(asc(auditLog.seq))
      .limit(batchSize);

    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, checked, seq: expectedSeq, reason: `ligne ${expectedSeq} manquante` };
      }
      if (row.prevHash !== prevHash) {
        return { ok: false, checked, seq: row.seq, reason: "lien avec la ligne précédente rompu" };
      }
      const recomputed = hashEntry({ ...row, data: row.data as JsonValue });
      if (recomputed !== row.hash) {
        return { ok: false, checked, seq: row.seq, reason: "contenu modifié" };
      }
      prevHash = row.hash;
      expectedSeq += 1;
      checked += 1;
    }

    if (rows.length < batchSize) {
      return { ok: true, checked, headHash: prevHash };
    }
  }
}
