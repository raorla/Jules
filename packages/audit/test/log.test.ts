import { DEFAULT_ORG_ID, auditLog, eq, orgs, sql } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, verifyAuditChain } from "../src/index.js";

let t: TestDatabase;
let orgId: string;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  // Une organisation neuve par test : chaque chaîne commence à 1.
  const [org] = await t.db
    .insert(orgs)
    .values({ slug: `org-${crypto.randomUUID()}`, name: "test" })
    .returning();
  orgId = org!.id;
});

const entry = (action: string, data: Record<string, string | number> = {}) => ({
  orgId,
  actor: { type: "system" as const, id: "worker" },
  action,
  target: { type: "task", id: "t1" },
  data,
});

/** Simule un attaquant qui a la main sur la base : il contourne le trigger append-only. */
async function tamper(statement: ReturnType<typeof sql>) {
  await t.db.transaction(async (tx) => {
    await tx.execute(sql`alter table audit_log disable trigger audit_log_no_update_delete`);
    await tx.execute(statement);
    await tx.execute(sql`alter table audit_log enable trigger audit_log_no_update_delete`);
  });
}

describe("journal d'audit", () => {
  it("chaîne les lignes et vérifie la chaîne", async () => {
    await appendAudit(t.db, entry("task.created", { issue: 1 }));
    await appendAudit(t.db, entry("task.comment_posted"));
    const third = await appendAudit(t.db, entry("task.cancelled"));

    const result = await verifyAuditChain(t.db, orgId);
    expect(result).toEqual({ ok: true, checked: 3, headHash: third.hash });
  });

  it("garde une séquence continue sous des ajouts concurrents", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAudit(t.db, entry("x", { i }))));

    const rows = await t.db.select().from(auditLog).where(eq(auditLog.orgId, orgId));
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect((await verifyAuditChain(t.db, orgId, { batchSize: 7 })).ok).toBe(true);
  });

  it("refuse UPDATE, DELETE et TRUNCATE", async () => {
    await appendAudit(t.db, entry("task.created"));

    await expect(t.db.execute(sql`update audit_log set action = 'x'`)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from audit_log`)).rejects.toThrow();
    await expect(t.db.execute(sql`truncate audit_log`)).rejects.toThrow();
  });

  it("détecte une ligne modifiée", async () => {
    await appendAudit(t.db, entry("task.created", { issue: 1 }));
    await appendAudit(t.db, entry("approval.granted", { gate: "H1" }));
    await appendAudit(t.db, entry("task.done"));

    await tamper(
      sql`update audit_log set data = '{"gate":"H2"}' where org_id = ${orgId} and seq = 2`,
    );

    expect(await verifyAuditChain(t.db, orgId)).toEqual({
      ok: false,
      checked: 1,
      seq: 2,
      reason: "contenu modifié",
    });
  });

  it("détecte une ligne modifiée dont le hash a été recalculé", async () => {
    await appendAudit(t.db, entry("a"));
    await appendAudit(t.db, entry("b"));
    await appendAudit(t.db, entry("c"));

    await tamper(
      sql`update audit_log set hash = ${"f".repeat(64)} where org_id = ${orgId} and seq = 2`,
    );

    const result = await verifyAuditChain(t.db, orgId);
    expect(result).toMatchObject({ ok: false, seq: 2 });
  });

  it("détecte une ligne supprimée", async () => {
    await appendAudit(t.db, entry("a"));
    await appendAudit(t.db, entry("b"));
    await appendAudit(t.db, entry("c"));

    await tamper(sql`delete from audit_log where org_id = ${orgId} and seq = 2`);

    expect(await verifyAuditChain(t.db, orgId)).toMatchObject({
      ok: false,
      seq: 2,
      reason: "ligne 2 manquante",
    });
  });

  it("refuse une donnée personnelle", async () => {
    await expect(appendAudit(t.db, { ...entry("x"), data: { login: "octocat" } })).rejects.toThrow(
      TypeError,
    );
  });

  it("tient une chaîne par organisation", async () => {
    await appendAudit(t.db, { ...entry("a"), orgId: DEFAULT_ORG_ID });
    const first = await appendAudit(t.db, entry("a"));
    expect(first.seq).toBe(1);
  });
});
