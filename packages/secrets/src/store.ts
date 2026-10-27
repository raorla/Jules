import { and, eq, ne, secrets, sql, type Db } from "@jules/db";
import {
  Keyring,
  decryptSecret,
  encryptSecret,
  parseMasterKey,
  rewrapSecret,
  type SealedSecret,
} from "./envelope.js";

// Secrets en base, chiffrés par enveloppe. Le contexte (organisation + nom) est lié au chiffré.

const context = (orgId: string, name: string) => `${orgId}:${name}`;

export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly keyring: Keyring,
  ) {}

  async set(orgId: string, name: string, value: Buffer | string): Promise<void> {
    const sealed = encryptSecret(value, this.keyring.current, context(orgId, name));
    await this.db
      .insert(secrets)
      .values({ orgId, name, ...sealed })
      .onConflictDoUpdate({
        target: [secrets.orgId, secrets.name],
        set: { ...sealed, updatedAt: sql`now()` },
      });
  }

  async get(orgId: string, name: string): Promise<Buffer | undefined> {
    const [row] = await this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.name, name)));
    return row ? decryptSecret(row, this.keyring, context(orgId, name)) : undefined;
  }

  async has(orgId: string, name: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.name, name)));
    return row !== undefined;
  }

  /**
   * Rechiffre les DEK encore liées à une ancienne clé maître avec la clé courante.
   * Le trousseau doit contenir l'ancienne clé. Renvoie le nombre de secrets rechiffrés.
   */
  async rotateMasterKey(): Promise<number> {
    const current = this.keyring.current.id;
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(secrets).where(ne(secrets.kekId, current)).for("update");
      for (const row of rows) {
        const rotated: SealedSecret = rewrapSecret(row, this.keyring, context(row.orgId, row.name));
        await tx
          .update(secrets)
          .set({ kekId: rotated.kekId, wrappedDek: rotated.wrappedDek, updatedAt: sql`now()` })
          .where(eq(secrets.id, row.id));
      }
      return rows.length;
    });
  }
}

/** Lit la clé maître et, pendant une rotation, les anciennes (séparées par des virgules). */
export function keyringFromEnv(env: {
  JULES_MASTER_KEY?: string | undefined;
  JULES_MASTER_KEY_PREVIOUS?: string | undefined;
}): Keyring {
  const current = env.JULES_MASTER_KEY;
  if (!current) {
    throw new Error("JULES_MASTER_KEY manquante");
  }
  const previous = (env.JULES_MASTER_KEY_PREVIOUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseMasterKey);
  return new Keyring(parseMasterKey(current), previous);
}
