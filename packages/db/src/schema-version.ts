import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { MIGRATIONS_FOLDER, type Db } from "./client.js";

// Version du schéma (M11) : le code connaît ses migrations (le journal de drizzle-kit), la base sait
// lesquelles ont été appliquées. L'api et le worker refusent de démarrer sur une base en retard (lancer
// `jules migrate`) ou en avance (un code plus ancien que la base, après un retour arrière mal fait).

export type Migration = { tag: string; when: number };

export function knownMigrations(folder: string = MIGRATIONS_FOLDER): Migration[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.map((e) => ({ tag: e.tag, when: e.when }));
}

export type SchemaStatus = {
  state: "current" | "behind" | "ahead" | "empty";
  applied: number;
  known: number;
  /** Dernière migration appliquée connue du code. */
  last?: string;
  /** Migrations appliquées que ce code ne connaît pas. */
  unknown: number;
};

export async function schemaStatus(
  db: Db,
  folder: string = MIGRATIONS_FOLDER,
): Promise<SchemaStatus> {
  const known = knownMigrations(folder);
  const table = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  );
  if (!table.rows[0]?.exists) {
    return { state: "empty", applied: 0, known: known.length, unknown: 0 };
  }
  const rows = await db.execute<{ created_at: string }>(
    sql`select created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  const applied = rows.rows.map((r) => Number(r.created_at));
  const byWhen = new Map(known.map((m) => [m.when, m]));
  const unknown = applied.filter((when) => !byWhen.has(when)).length;
  const lastKnown = [...applied].reverse().find((when) => byWhen.has(when));
  const latest = known.at(-1)?.when ?? 0;
  const state =
    unknown > 0
      ? "ahead"
      : applied.length === 0
        ? "empty"
        : (applied.at(-1) ?? 0) < latest
          ? "behind"
          : "current";
  return {
    state,
    applied: applied.length,
    known: known.length,
    ...(lastKnown !== undefined ? { last: byWhen.get(lastKnown)?.tag ?? "" } : {}),
    unknown,
  };
}

export class SchemaVersionError extends Error {
  override readonly name = "SchemaVersionError";
}

/** Au démarrage de l'api et du worker : la base doit avoir exactement les migrations du code. */
export async function assertSchemaCurrent(db: Db): Promise<SchemaStatus> {
  const status = await schemaStatus(db);
  if (status.state === "ahead") {
    throw new SchemaVersionError(
      `base plus récente que ce code (${status.unknown} migration(s) inconnue(s)) : installe la version de Jules qui correspond à la base, ou restaure la sauvegarde d'avant la montée de version`,
    );
  }
  if (status.state !== "current") {
    throw new SchemaVersionError(
      `base en retard (${status.applied}/${status.known} migrations) : lance \`jules migrate\``,
    );
  }
  return status;
}
