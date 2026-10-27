import { DEFAULT_ORG_ID, secrets, sql } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keyring, SecretStore, generateMasterKey, parseMasterKey } from "../src/index.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});

describe("SecretStore", () => {
  it("ne stocke jamais la valeur en clair", async () => {
    const store = new SecretStore(t.db, new Keyring(parseMasterKey(generateMasterKey())));
    await store.set(DEFAULT_ORG_ID, "plain-check", "valeur-tres-secrete");

    const dump = await t.db.execute(sql`select * from secrets`);
    expect(JSON.stringify(dump.rows)).not.toContain("valeur-tres-secrete");
    expect((await store.get(DEFAULT_ORG_ID, "plain-check"))?.toString()).toBe(
      "valeur-tres-secrete",
    );
  });

  it("remplace la valeur d'un secret existant", async () => {
    const store = new SecretStore(t.db, new Keyring(parseMasterKey(generateMasterKey())));
    await store.set(DEFAULT_ORG_ID, "replace", "v1");
    await store.set(DEFAULT_ORG_ID, "replace", "v2");

    expect((await store.get(DEFAULT_ORG_ID, "replace"))?.toString()).toBe("v2");
    expect(await store.get(DEFAULT_ORG_ID, "absent")).toBeUndefined();
  });

  it("refuse une ligne recopiée sur un autre secret", async () => {
    const store = new SecretStore(t.db, new Keyring(parseMasterKey(generateMasterKey())));
    await store.set(DEFAULT_ORG_ID, "source", "à voler");
    await store.set(DEFAULT_ORG_ID, "cible", "autre");
    await t.db.execute(sql`
      update secrets set wrapped_dek = s.wrapped_dek, ciphertext = s.ciphertext, kek_id = s.kek_id
      from secrets s where s.name = 'source' and secrets.name = 'cible'`);

    await expect(store.get(DEFAULT_ORG_ID, "cible")).rejects.toThrow(/déchiffrement impossible/);
  });

  it("fait tourner la clé maître", async () => {
    await t.db.delete(secrets);
    const oldKey = parseMasterKey(generateMasterKey());
    const newKey = parseMasterKey(generateMasterKey());
    await new SecretStore(t.db, new Keyring(oldKey)).set(DEFAULT_ORG_ID, "ssh", "clé ssh");
    await new SecretStore(t.db, new Keyring(oldKey)).set(DEFAULT_ORG_ID, "gh", "clé app");

    const rotating = new SecretStore(t.db, new Keyring(newKey, [oldKey]));
    expect(await rotating.rotateMasterKey()).toBe(2);
    expect(await rotating.rotateMasterKey()).toBe(0);

    const afterRotation = new SecretStore(t.db, new Keyring(newKey));
    expect((await afterRotation.get(DEFAULT_ORG_ID, "ssh"))?.toString()).toBe("clé ssh");
    expect((await afterRotation.get(DEFAULT_ORG_ID, "gh"))?.toString()).toBe("clé app");
  });
});
