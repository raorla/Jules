import { appendAudit, verifyAuditChain } from "@jules/audit";
import { DEFAULT_ORG_ID, createDatabase, migrate, sql, type Database } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { Keyring, SecretStore, generateMasterKey, parseMasterKey } from "@jules/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_APP_KEY_SECRET } from "../src/config.js";

// DoD M0 : une restauration depuis une sauvegarde redonne une base utilisable, secrets compris.
// Même format que deploy/backup (pg_dump -Fc), restauré dans une base neuve.

let t: TestDatabase;
let restored: Database;
const master = parseMasterKey(generateMasterKey());

async function exec(command: string[]) {
  const result = await t.container.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} : ${result.output}`);
  }
}

beforeAll(async () => {
  t = await startTestDatabase();
  const store = new SecretStore(t.db, new Keyring(master));
  await store.set(DEFAULT_ORG_ID, GITHUB_APP_KEY_SECRET, "-----BEGIN RSA PRIVATE KEY-----");
  await appendAudit(t.db, {
    orgId: DEFAULT_ORG_ID,
    actor: { type: "system", id: "test" },
    action: "a",
  });
  await appendAudit(t.db, {
    orgId: DEFAULT_ORG_ID,
    actor: { type: "system", id: "test" },
    action: "b",
  });

  const user = t.container.getUsername();
  await exec([
    "pg_dump",
    "-U",
    user,
    "-d",
    t.container.getDatabase(),
    "-Fc",
    "-f",
    "/tmp/jules.dump",
  ]);
  await exec(["createdb", "-U", user, "restored"]);
  await exec(["pg_restore", "-U", user, "-d", "restored", "--no-owner", "/tmp/jules.dump"]);

  const url = new URL(t.url);
  url.pathname = "/restored";
  restored = createDatabase(url.toString(), { max: 2 });
});
afterAll(async () => {
  await restored.close();
  await t.stop();
});

describe("restauration d'une sauvegarde", () => {
  it("rend les secrets avec la clé maître gardée hors de la base", async () => {
    const value = await new SecretStore(restored.db, new Keyring(master)).get(
      DEFAULT_ORG_ID,
      GITHUB_APP_KEY_SECRET,
    );
    expect(value?.toString()).toBe("-----BEGIN RSA PRIVATE KEY-----");
  });

  it("ne rend rien sans la clé maître", async () => {
    const other = new Keyring(parseMasterKey(generateMasterKey()));
    await expect(
      new SecretStore(restored.db, other).get(DEFAULT_ORG_ID, GITHUB_APP_KEY_SECRET),
    ).rejects.toThrow();
  });

  it("garde une chaîne d'audit intacte et toujours append-only", async () => {
    expect(await verifyAuditChain(restored.db, DEFAULT_ORG_ID)).toMatchObject({
      ok: true,
      checked: 2,
    });
    await expect(restored.db.execute(sql`delete from audit_log`)).rejects.toThrow();
  });

  it("reste à jour pour les migrations et accepte de nouvelles écritures", async () => {
    await migrate(restored.db);
    await appendAudit(restored.db, {
      orgId: DEFAULT_ORG_ID,
      actor: { type: "system", id: "test" },
      action: "c",
    });
    expect(await verifyAuditChain(restored.db, DEFAULT_ORG_ID)).toMatchObject({
      ok: true,
      checked: 3,
    });
  });
});
