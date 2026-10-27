import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { CHANNELS, DEFAULT_ORG_ID, events, orgs, outbox, sql } from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "../src/testing.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});

describe("schéma", () => {
  it("met un org_id non nul sur chaque table (ADR 0013)", async () => {
    const { rows } = await t.db.execute<{ table_name: string; is_nullable: string | null }>(sql`
      select t.table_name, c.is_nullable
      from information_schema.tables t
      left join information_schema.columns c
        on c.table_schema = t.table_schema and c.table_name = t.table_name and c.column_name = 'org_id'
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> 'orgs'`);

    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => r.is_nullable !== "NO").map((r) => r.table_name)).toEqual([]);
  });

  it("crée l'organisation par défaut", async () => {
    const [org] = await t.db.select().from(orgs);
    expect(org).toMatchObject({ id: DEFAULT_ORG_ID, slug: "default" });
  });

  it("notifie le worker à chaque événement et à chaque effet", async () => {
    const listener = new pg.Client({ connectionString: t.url });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (m) => received.push(m.channel));
    await listener.query(`LISTEN ${CHANNELS.events}`);
    await listener.query(`LISTEN ${CHANNELS.outbox}`);

    await t.db.insert(events).values({ orgId: DEFAULT_ORG_ID, deliveryId: "d1", event: "ping" });
    await t.db
      .insert(outbox)
      .values({ orgId: DEFAULT_ORG_ID, kind: "k", idempotencyKey: "i1", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await listener.end();

    expect(received.sort()).toEqual([CHANNELS.events, CHANNELS.outbox].sort());
  });
});
