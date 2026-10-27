import { appendAudit } from "@jules/audit";
import { DEFAULT_ORG_ID, desc, eq, secretSubmissions, workerKeys, type Db } from "@jules/db";
import type { SecretStore } from "@jules/secrets";
import sodium from "libsodium-wrappers";

// Secrets en écriture seule (ARCHITECTURE.md §4.2, ADR 0012) : l'api scelle la valeur avec la clé
// publique du worker ; seul le worker, qui garde la clé privée chiffrée par la clé maître, l'ouvre,
// puis la range dans `secrets`. Une api compromise ne peut donc relire aucun secret.

export const WORKER_BOX_SECRET = "worker_box_private_key";

export async function ensureWorkerKey(
  db: Db,
  store: SecretStore,
): Promise<{ id: string; publicKey: Uint8Array; privateKey: Uint8Array }> {
  await sodium.ready;
  const [current] = await db.select().from(workerKeys).orderBy(desc(workerKeys.createdAt)).limit(1);
  const stored = await store.get(DEFAULT_ORG_ID, WORKER_BOX_SECRET);
  if (current && stored) {
    return {
      id: current.id,
      publicKey: sodium.from_base64(current.publicKey, sodium.base64_variants.ORIGINAL),
      privateKey: new Uint8Array(stored),
    };
  }
  const pair = sodium.crypto_box_keypair();
  await store.set(DEFAULT_ORG_ID, WORKER_BOX_SECRET, Buffer.from(pair.privateKey));
  const [row] = await db
    .insert(workerKeys)
    .values({
      orgId: DEFAULT_ORG_ID,
      publicKey: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    })
    .returning();
  return { id: row?.id ?? "", publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function drainSecretSubmissions(db: Db, store: SecretStore): Promise<number> {
  const pending = await db.select().from(secretSubmissions);
  if (pending.length === 0) {
    return 0;
  }
  const key = await ensureWorkerKey(db, store);
  let imported = 0;
  for (const submission of pending) {
    if (submission.workerKeyId === key.id) {
      const value = sodium.crypto_box_seal_open(
        sodium.from_base64(submission.sealed, sodium.base64_variants.ORIGINAL),
        key.publicKey,
        key.privateKey,
      );
      await store.set(submission.orgId, submission.name, Buffer.from(value));
      value.fill(0);
      imported += 1;
      await appendAudit(db, {
        orgId: submission.orgId,
        actor: { type: "system", id: "worker" },
        action: "secret.stored",
        target: { type: "secret", id: submission.name },
      });
    }
    // Scellé pour une ancienne clé : illisible, on le retire (l'admin devra le saisir à nouveau).
    await db.delete(secretSubmissions).where(eq(secretSubmissions.id, submission.id));
  }
  return imported;
}
