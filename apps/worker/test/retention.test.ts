import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORG_ID, eq, events, outbox } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareEvals, loadSuite, scoreTask } from "../src/evals.js";
import { TRANSCRIPTS_DIR, purgeExpired } from "../src/retention.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});

const gates = (fail: boolean) => ({
  commit: "x",
  results: [
    { id: "G5.5", name: "Tests", status: fail ? "fail" : "pass", durationMs: 0, details: "" },
  ],
});

describe("rétention (ARCHITECTURE.md §18)", () => {
  it("purge les payloads, les transcriptions et les dossiers d'exécution expirés", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const [expired] = await t.db
      .insert(events)
      .values({
        orgId: DEFAULT_ORG_ID,
        deliveryId: crypto.randomUUID(),
        event: "issues",
        payload: { x: 1 },
        status: "processed",
        receivedAt: old,
      })
      .returning();
    const [recent] = await t.db
      .insert(events)
      .values({
        orgId: DEFAULT_ORG_ID,
        deliveryId: crypto.randomUUID(),
        event: "issues",
        payload: { x: 1 },
        status: "processed",
      })
      .returning();
    const runsDir = mkdtempSync(join(tmpdir(), "jules-retention-"));
    const age = (path: string, days: number) => {
      const when = new Date(Date.now() - days * 86_400_000);
      utimesSync(path, when, when);
    };
    mkdirSync(join(runsDir, TRANSCRIPTS_DIR));
    writeFileSync(join(runsDir, TRANSCRIPTS_DIR, "old.jsonl"), "{}");
    age(join(runsDir, TRANSCRIPTS_DIR, "old.jsonl"), 100);
    writeFileSync(join(runsDir, TRANSCRIPTS_DIR, "new.jsonl"), "{}");
    for (const name of ["old-run", "pending-run", "fresh-run"]) {
      mkdirSync(join(runsDir, name, "pristine.git"), { recursive: true });
      age(join(runsDir, name), name === "fresh-run" ? 1 : 10);
    }
    await t.db.insert(outbox).values({
      orgId: DEFAULT_ORG_ID,
      kind: "git.push",
      idempotencyKey: crypto.randomUUID(),
      payload: { pristineDir: join(runsDir, "pending-run", "pristine.git") },
    });

    expect(await purgeExpired(t.db, { runsDir })).toEqual({
      eventPayloads: 1,
      transcripts: 1,
      workDirs: 1,
    });

    expect((await t.db.select().from(events).where(eq(events.id, expired!.id)))[0]).toMatchObject({
      payload: null,
      deliveryId: expired!.deliveryId,
    });
    expect((await t.db.select().from(events).where(eq(events.id, recent!.id)))[0]?.payload).toEqual(
      { x: 1 },
    );
    expect(existsSync(join(runsDir, "old-run"))).toBe(false);
    expect(existsSync(join(runsDir, "pending-run"))).toBe(true);
    expect(existsSync(join(runsDir, "fresh-run"))).toBe(true);
    expect(existsSync(join(runsDir, TRANSCRIPTS_DIR, "new.jsonl"))).toBe(true);
  });
});

describe("suite d'evals livrée", () => {
  it("se charge, et chaque fixture déclare la commande de test que rejouent les gates", () => {
    const suite = fileURLToPath(new URL("../../../evals", import.meta.url));
    const loaded = loadSuite(suite);
    expect(loaded.map((task) => task.id)).toEqual([
      "average-empty",
      "mul",
      "readme-sum",
      "round-half",
      "sum-strings",
    ]);
    for (const task of loaded) {
      expect(existsSync(join(suite, task.fixture, ".jules", "config.yml")), task.id).toBe(true);
    }
  });
});

describe("score des evals", () => {
  const review = {
    verdict: "approve" as const,
    summary: "ok",
    acVerdicts: [{ ac: "AC-1", status: "met" as const, note: "" }],
    findings: [],
  };

  it("donne 100 à une tâche parfaite et gratuite, et plafonne une tâche non livrée", () => {
    expect(
      scoreTask({
        state: "awaiting_human_review",
        gates: gates(false) as never,
        review,
        acCount: 1,
        costUsd: 0,
        budgetUsd: 10,
      }).score,
    ).toBe(100);
    expect(
      scoreTask({
        state: "blocked",
        gates: gates(false) as never,
        review,
        acCount: 1,
        costUsd: 0,
        budgetUsd: 10,
      }).score,
    ).toBe(10);
    expect(
      scoreTask({
        state: "awaiting_human_review",
        gates: gates(true) as never,
        acCount: 2,
        costUsd: 10,
        budgetUsd: 10,
      }).score,
    ).toBe(0);
  });

  it("compare avec une tolérance", () => {
    const run = (score: number) => ({
      label: "x",
      total: score,
      tasks: [
        {
          id: "a",
          score,
          state: "done",
          details: { gates: 0, criteria: 0, review: 0, cost: 0, costUsd: 0 },
        },
      ],
    });
    expect(compareEvals(run(80), run(79)).ok).toBe(true);
    expect(compareEvals(run(80), run(70))).toMatchObject({
      ok: false,
      delta: -10,
      regressions: ["a : 80 → 70"],
    });
  });
});
