import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, verifyAuditChain } from "@jules/audit";
import {
  DEFAULT_ORG_ID,
  MIGRATIONS_FOLDER,
  SchemaVersionError,
  artifacts,
  assertSchemaCurrent,
  eq,
  installations,
  lessons,
  migrate,
  orgs,
  repos,
  schemaStatus,
  sql,
  tasks,
  users,
} from "@jules/db";
import { migrateTo, startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { Keyring, SecretStore, generateMasterKey, parseMasterKey } from "@jules/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANTHROPIC_KEY_SECRET } from "../src/config.js";

// DoD M11 (ROADMAP.md) : la montée de version depuis la version précédente se fait sans perte de
// données. Point de départ : le noyau publié à la fin de l'étape 1 (M5, migration 0006), avec des
// données réelles ; arrivée : la 1.0, par la même commande que sur le serveur (`jules migrate`).

const RELEASE_CORE = "0006_lessons";

let t: TestDatabase;
const master = parseMasterKey(generateMasterKey());

beforeAll(async () => {
  t = await startTestDatabase({ migrated: false });
});
afterAll(async () => {
  await t.stop();
});

describe("montée de version (M11)", () => {
  it("du noyau (M5) à la 1.0 sans perte : tâches, artefacts, leçons, secrets, journal d'audit", async () => {
    expect((await schemaStatus(t.db)).state).toBe("empty");
    await migrateTo(t.db, RELEASE_CORE);
    expect(await schemaStatus(t.db)).toMatchObject({ state: "behind", last: RELEASE_CORE });
    await expect(assertSchemaCurrent(t.db)).rejects.toThrow(/en retard.*jules migrate/);

    // Une instance du noyau en service.
    const [installation] = await t.db
      .insert(installations)
      .values({
        orgId: DEFAULT_ORG_ID,
        githubInstallationId: 77,
        accountLogin: "acme",
        accountType: "Organization",
      })
      .returning();
    const [repo] = await t.db
      .insert(repos)
      .values({
        orgId: DEFAULT_ORG_ID,
        forge: "github",
        installationId: installation!.id,
        githubRepoId: 4242,
        fullName: "acme/app",
        defaultBranch: "main",
        private: true,
        autonomy: "L2",
      })
      .returning();
    const [user] = await t.db
      .insert(users)
      .values({ orgId: DEFAULT_ORG_ID, githubUserId: 1, login: "alice", kind: "human" })
      .returning();
    const created = await t.db
      .insert(tasks)
      .values(
        ["done", "awaiting_human_review", "building"].map((state, i) => ({
          orgId: DEFAULT_ORG_ID,
          repoId: repo!.id,
          agent: "developer" as const,
          issueNumber: 10 + i,
          title: `Tâche ${i}`,
          request: "Ajoute une fonction.",
          state: state as "done",
          createdBy: user!.id,
          costUsd: "1.2345",
        })),
      )
      .returning();
    await t.db.insert(artifacts).values({
      orgId: DEFAULT_ORG_ID,
      taskId: created[0]!.id,
      kind: "spec",
      version: 1,
      content: { problem: "Pas de multiplication.", acceptanceCriteria: [{ id: "AC-1" }] },
    });
    await t.db.insert(lessons).values({
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      taskId: created[0]!.id,
      text: "Les fonctions de calcul vivent dans src/math.js.",
      source: "review humaine",
      status: "approved",
    });
    await new SecretStore(t.db, new Keyring(master)).set(
      DEFAULT_ORG_ID,
      ANTHROPIC_KEY_SECRET,
      "sk-valeur-de-test",
    );
    for (const action of ["task.created", "gate.approved", "pr.merged"]) {
      await appendAudit(t.db, {
        orgId: DEFAULT_ORG_ID,
        actor: { type: "user", id: user!.id },
        action,
        target: { type: "task", id: created[0]!.id },
      });
    }
    const before = await counts();

    // La montée de version : la même fonction que `jules migrate`, deux fois (idempotente).
    await migrate(t.db);
    await migrate(t.db);

    expect(await assertSchemaCurrent(t.db)).toMatchObject({ state: "current" });
    expect(await counts()).toEqual(before);
    const [task] = await t.db.select().from(tasks).where(eq(tasks.id, created[0]!.id));
    expect(task).toMatchObject({
      state: "done",
      issueNumber: 10,
      costUsd: "1.2345",
      createdBy: user!.id,
    });
    const [spec] = await t.db.select().from(artifacts).where(eq(artifacts.taskId, created[0]!.id));
    expect(spec?.content).toEqual({
      problem: "Pas de multiplication.",
      acceptanceCriteria: [{ id: "AC-1" }],
    });
    expect((await t.db.select().from(lessons))[0]).toMatchObject({ status: "approved" });
    expect(
      (
        await new SecretStore(t.db, new Keyring(master)).get(DEFAULT_ORG_ID, ANTHROPIC_KEY_SECRET)
      )?.toString(),
    ).toBe("sk-valeur-de-test");
    expect(await verifyAuditChain(t.db, DEFAULT_ORG_ID)).toMatchObject({ ok: true, checked: 3 });
    // Les colonnes ajoutées depuis prennent leur valeur par défaut, la plus prudente.
    expect((await t.db.select().from(orgs))[0]).toMatchObject({
      fourEyes: false,
      githubProductionApproval: false,
      securityLevel: "S0",
    });

    // Retour arrière mal fait : une base plus récente que le code est refusée au démarrage.
    await t.db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', ${Date.now() + 86_400_000})`,
    );
    expect((await schemaStatus(t.db)).state).toBe("ahead");
    await expect(assertSchemaCurrent(t.db)).rejects.toThrow(SchemaVersionError);
    await expect(assertSchemaCurrent(t.db)).rejects.toThrow(/plus récente que ce code/);
    await t.db.execute(sql`delete from drizzle.__drizzle_migrations where hash = 'future'`);
  });

  it("aucune migration ne détruit de données sans le dire", () => {
    // Une migration qui supprime une table ou une colonne, change un type ou renomme doit porter
    // le commentaire `-- jules: destructif accepté : <raison>` et un plan de reprise.
    const destructive =
      /\b(DROP\s+(TABLE|COLUMN|SCHEMA)|ALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE|RENAME\s+(TO|COLUMN)|TRUNCATE\s+(?!ON\b)|DELETE\s+FROM)\b/i;
    const offenders = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const text = readFileSync(join(MIGRATIONS_FOLDER, f), "utf8");
        return destructive.test(text) && !text.includes("-- jules: destructif accepté :");
      });
    expect(offenders).toEqual([]);
  });
});

async function counts() {
  const { rows } = await t.db.execute<Record<string, string>>(sql`
    select (select count(*) from tasks) as tasks, (select count(*) from artifacts) as artifacts,
           (select count(*) from lessons) as lessons, (select count(*) from secrets) as secrets,
           (select count(*) from audit_log) as audit, (select count(*) from repos) as repos,
           (select count(*) from users) as users`);
  return rows[0];
}
