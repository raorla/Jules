import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** Une transaction Drizzle : même API que Db, à passer aux fonctions qui doivent écrire ensemble. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** Organisation créée par la première migration : l'instance tant que le multi-organisation n'est pas activé. */
export const DEFAULT_ORG_ID = "00000000-0000-4000-8000-000000000001";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export type Database = {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
};

export function createDatabase(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export async function migrate(db: Db): Promise<void> {
  await runMigrations(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Canaux LISTEN/NOTIFY déclenchés par les triggers de la migration 0001. */
export const CHANNELS = {
  events: "jules_events",
  outbox: "jules_outbox",
  tasks: "jules_tasks",
  commands: "jules_commands",
} as const;
