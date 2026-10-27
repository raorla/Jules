import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, migrate, type Database } from "./client.js";

// Une vraie base PostgreSQL par fichier de test (Testcontainers), migrée comme en production.

export const POSTGRES_IMAGE = "postgres:18-alpine";

export type TestDatabase = Database & {
  readonly container: StartedPostgreSqlContainer;
  readonly url: string;
  stop(): Promise<void>;
};

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  const database = createDatabase(url, { max: 5 });
  await migrate(database.db);
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
