import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Chiffrement enveloppe (ARCHITECTURE.md §5, §17) :
// - chaque secret est chiffré par sa propre clé de données (DEK), en AES-256-GCM ;
// - la DEK est chiffrée par la clé maître (KEK), qui n'est jamais en base ;
// - faire tourner la clé maître ne rechiffre que les DEK, jamais les valeurs.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

export type MasterKey = {
  /** Empreinte publique de la clé, stockée avec chaque secret pour savoir laquelle l'a chiffré. */
  readonly id: string;
  readonly key: Buffer;
};

export type SealedSecret = {
  readonly kekId: string;
  /** DEK chiffrée par la clé maître : version | iv | tag | chiffré, en base64. */
  readonly wrappedDek: string;
  /** Valeur chiffrée par la DEK : version | iv | tag | chiffré, en base64. */
  readonly ciphertext: string;
};

export class SecretsError extends Error {
  override readonly name = "SecretsError";
}

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function fingerprint(key: Buffer): string {
  return createHash("sha256").update("jules:kek:").update(key).digest("hex").slice(0, 16);
}

export function parseMasterKey(encoded: string): MasterKey {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretsError(`la clé maître doit faire ${KEY_BYTES} octets encodés en base64`);
  }
  return { id: fingerprint(key), key };
}

/** Clé courante, plus les anciennes clés le temps d'une rotation. */
export class Keyring {
  readonly current: MasterKey;
  readonly #byId: Map<string, MasterKey>;

  constructor(current: MasterKey, previous: readonly MasterKey[] = []) {
    this.current = current;
    this.#byId = new Map([...previous, current].map((k) => [k.id, k]));
  }

  get(id: string): MasterKey {
    const key = this.#byId.get(id);
    if (!key) {
      throw new SecretsError(`clé maître ${id} absente du trousseau`);
    }
    return key;
  }
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(FORMAT_VERSION), iv, cipher.getAuthTag(), encrypted]).toString(
    "base64",
  );
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 1 + IV_BYTES + TAG_BYTES || raw[0] !== FORMAT_VERSION) {
    throw new SecretsError("format de secret inconnu");
  }
  const iv = raw.subarray(1, 1 + IV_BYTES);
  const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(1 + IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new SecretsError("déchiffrement impossible : clé, contexte ou donnée invalide");
  }
}

/**
 * `context` lie le chiffré à son emplacement (organisation et nom du secret) :
 * recopier le chiffré d'un secret sur un autre le rend indéchiffrable.
 */
export function encryptSecret(
  plaintext: Buffer | string,
  master: MasterKey,
  context: string,
): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    const value = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    return {
      kekId: master.id,
      wrappedDek: seal(master.key, dek, `jules:dek:${context}`),
      ciphertext: seal(dek, value, `jules:secret:${context}`),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(sealed: SealedSecret, keyring: Keyring, context: string): Buffer {
  const dek = open(keyring.get(sealed.kekId).key, sealed.wrappedDek, `jules:dek:${context}`);
  try {
    return open(dek, sealed.ciphertext, `jules:secret:${context}`);
  } finally {
    dek.fill(0);
  }
}

/** Rechiffre la DEK avec la clé courante du trousseau ; la valeur chiffrée ne change pas. */
export function rewrapSecret(
  sealed: SealedSecret,
  keyring: Keyring,
  context: string,
): SealedSecret {
  if (sealed.kekId === keyring.current.id) {
    return sealed;
  }
  const dek = open(keyring.get(sealed.kekId).key, sealed.wrappedDek, `jules:dek:${context}`);
  try {
    return {
      kekId: keyring.current.id,
      wrappedDek: seal(keyring.current.key, dek, `jules:dek:${context}`),
      ciphertext: sealed.ciphertext,
    };
  } finally {
    dek.fill(0);
  }
}
