import { DEFAULT_ORG_ID, events, type Db } from "@jules/db";
import type { GitHubApp } from "@jules/forge";
import pino from "pino";
import type { WorkerDeps } from "../src/deps.js";

export function testDeps(db: Db, github: GitHubApp): WorkerDeps {
  return {
    db,
    github,
    log: pino({ level: "silent" }),
    settings: { mention: "@jules", label: "jules", language: "fr" },
  };
}

/** Comme le gateway : un webhook déjà vérifié, stocké tel quel. */
export async function storeEvent(db: Db, event: string, payload: { action?: string }) {
  const [row] = await db
    .insert(events)
    .values({
      orgId: DEFAULT_ORG_ID,
      deliveryId: crypto.randomUUID(),
      event,
      action: payload.action ?? null,
      githubInstallationId: 4242,
      payload,
    })
    .returning();
  return row!;
}

export async function eventually<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("condition jamais atteinte");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
