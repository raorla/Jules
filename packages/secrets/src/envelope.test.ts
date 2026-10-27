import { describe, expect, it } from "vitest";
import {
  Keyring,
  SecretsError,
  decryptSecret,
  encryptSecret,
  fingerprint,
  generateMasterKey,
  parseMasterKey,
  rewrapSecret,
} from "./envelope.js";

const ctx = "org-1:github_app_private_key";

describe("chiffrement enveloppe", () => {
  it("rend la valeur d'origine", () => {
    const master = parseMasterKey(generateMasterKey());
    const sealed = encryptSecret("-----BEGIN KEY-----", master, ctx);

    expect(sealed.kekId).toBe(master.id);
    expect(sealed.ciphertext).not.toContain("BEGIN");
    expect(decryptSecret(sealed, new Keyring(master), ctx).toString()).toBe("-----BEGIN KEY-----");
  });

  it("utilise une DEK et un IV neufs à chaque chiffrement", () => {
    const master = parseMasterKey(generateMasterKey());
    const a = encryptSecret("même valeur", master, ctx);
    const b = encryptSecret("même valeur", master, ctx);

    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuse un chiffré déplacé sur un autre secret", () => {
    const master = parseMasterKey(generateMasterKey());
    const sealed = encryptSecret("valeur", master, ctx);

    expect(() => decryptSecret(sealed, new Keyring(master), "org-1:autre")).toThrow(SecretsError);
    expect(() =>
      decryptSecret(sealed, new Keyring(master), "org-2:github_app_private_key"),
    ).toThrow(SecretsError);
  });

  it("refuse un chiffré altéré", () => {
    const master = parseMasterKey(generateMasterKey());
    const sealed = encryptSecret("valeur", master, ctx);
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;

    expect(() =>
      decryptSecret({ ...sealed, ciphertext: raw.toString("base64") }, new Keyring(master), ctx),
    ).toThrow(SecretsError);
  });

  it("refuse une mauvaise clé maître", () => {
    const sealed = encryptSecret("valeur", parseMasterKey(generateMasterKey()), ctx);
    const other = parseMasterKey(generateMasterKey());

    expect(() => decryptSecret({ ...sealed, kekId: other.id }, new Keyring(other), ctx)).toThrow(
      SecretsError,
    );
    expect(() => decryptSecret(sealed, new Keyring(other), ctx)).toThrow(/absente du trousseau/);
  });

  it("fait tourner la clé maître sans toucher la valeur chiffrée", () => {
    const oldKey = parseMasterKey(generateMasterKey());
    const newKey = parseMasterKey(generateMasterKey());
    const sealed = encryptSecret("valeur", oldKey, ctx);

    const rotated = rewrapSecret(sealed, new Keyring(newKey, [oldKey]), ctx);

    expect(rotated.kekId).toBe(newKey.id);
    expect(rotated.ciphertext).toBe(sealed.ciphertext);
    expect(decryptSecret(rotated, new Keyring(newKey), ctx).toString()).toBe("valeur");
    expect(rewrapSecret(rotated, new Keyring(newKey), ctx)).toBe(rotated);
  });

  it("refuse une clé maître de mauvaise taille", () => {
    expect(() => parseMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(SecretsError);
  });

  it("donne une empreinte stable qui ne révèle pas la clé", () => {
    const encoded = generateMasterKey();
    const key = Buffer.from(encoded, "base64");

    expect(parseMasterKey(encoded).id).toBe(fingerprint(key));
    expect(fingerprint(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(key)).not.toContain(key.toString("hex").slice(0, 16));
  });
});
