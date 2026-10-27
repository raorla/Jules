import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { MIGRATIONS_FOLDER, createDatabase, migrate, type Database, type Db } from "./client.js";

// Une vraie base PostgreSQL par fichier de test (Testcontainers), migrée comme en production.

export const POSTGRES_IMAGE = "postgres:18-alpine";

export type TestDatabase = Database & {
  readonly container: StartedPostgreSqlContainer;
  readonly url: string;
  stop(): Promise<void>;
};

export async function startTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  const database = createDatabase(url, { max: 5 });
  if (options.migrated ?? true) {
    await migrate(database.db);
  }
  return {
    ...database,
    container,
    url,
    async stop() {
      await database.close();
      await container.stop();
    },
  };
}

/**
 * Applique les migrations jusqu'à `tag` compris, comme une version publiée de Jules l'aurait fait :
 * point de départ des tests de montée de version (M11).
 */
export async function migrateTo(db: Db, tag: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "jules-migrations-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((e) => e.tag === tag);
  if (index < 0) {
    throw new Error(`migration inconnue : ${tag}`);
  }
  writeFileSync(path, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index + 1) }));
  await runMigrations(db, { migrationsFolder: folder });
}
