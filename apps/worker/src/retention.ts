import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, events, inArray, isNull, lt, outbox, sql, type Db } from "@jules/db";

// Durées de conservation (ARCHITECTURE.md §18), appliquées toutes les heures par le worker et par
// `jules purge`. Le journal d'audit est permanent ; les artefacts vivent aussi longtemps que le repo.

export type RetentionPolicy = {
  /** Payload des webhooks bruts. L'identifiant de livraison reste, pour refuser un rejeu. */
  eventPayloadDays: number;
  /** Transcriptions masquées des exécutions. */
  transcriptDays: number;
  /** Workspaces, clones et exports des exécutions terminées. */
  workDirDays: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = {
  eventPayloadDays: 30,
  transcriptDays: 90,
  workDirDays: 7,
};
export const TRANSCRIPTS_DIR = "_transcripts";

export type PurgeReport = { eventPayloads: number; transcripts: number; workDirs: number };

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

async function olderThan(path: string, limit: Date): Promise<boolean> {
  try {
    return (await stat(path)).mtime < limit;
  } catch {
    return false;
  }
}

export async function purgeExpired(
  db: Db,
  options: {
    runsDir: string;
    policy?: RetentionPolicy;
    now?: Date;
    activeRuns?: ReadonlySet<string>;
  },
): Promise<PurgeReport> {
  const policy = options.policy ?? DEFAULT_RETENTION;
  const now = options.now ?? new Date();

  const purged = await db
    .update(events)
    .set({ payload: null, purgedAt: sql`now()` })
    .where(
      and(
        lt(events.receivedAt, daysAgo(now, policy.eventPayloadDays)),
        isNull(events.purgedAt),
        inArray(events.status, ["processed", "ignored", "failed"]),
      ),
    )
    .returning({ id: events.id });

  let transcripts = 0;
  const transcriptDir = join(options.runsDir, TRANSCRIPTS_DIR);
  for (const name of await readdir(transcriptDir).catch(() => [] as string[])) {
    if (await olderThan(join(transcriptDir, name), daysAgo(now, policy.transcriptDays))) {
      await rm(join(transcriptDir, name), { force: true });
      transcripts += 1;
    }
  }

  // Un pristine encore référencé par un push en attente ne doit pas disparaître.
  const pending = await db
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(and(inArray(outbox.status, ["pending", "running"]), sql`${outbox.kind} = 'git.push'`));
  const needed = new Set(
    pending.map((p) => (p.payload as { pristineDir?: string }).pristineDir ?? ""),
  );
  let workDirs = 0;
  for (const name of await readdir(options.runsDir).catch(() => [] as string[])) {
    const path = join(options.runsDir, name);
    const runId = name.replace(/-(verify|export)$/, "");
    if (
      name === TRANSCRIPTS_DIR ||
      options.activeRuns?.has(runId) ||
      [...needed].some((p) => p.startsWith(`${path}/`))
    ) {
      continue;
    }
    if (await olderThan(path, daysAgo(now, policy.workDirDays))) {
      await rm(path, { recursive: true, force: true });
      workDirs += 1;
    }
  }
  return { eventPayloads: purged.length, transcripts, workDirs };
}
