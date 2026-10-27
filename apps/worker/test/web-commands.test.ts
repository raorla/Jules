import {
  DEFAULT_ORG_ID,
  and,
  artifacts,
  commands,
  eq,
  events,
  memberships,
  outbox,
  secretSubmissions,
  sql,
  tasks,
  users,
  workerKeys,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { FakeGitHub } from "@jules/forge/testing";
import { Keyring, SecretStore, generateMasterKey, parseMasterKey } from "@jules/secrets";
import sodium from "libsodium-wrappers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { drainSecretSubmissions, ensureWorkerKey } from "../src/sealed-secrets.js";
import { drainWebCommands } from "../src/web-commands.js";
import { issueComment } from "./fixtures.js";
import { seedTask, testDeps } from "./harness.js";

// Commandes du web (DoD M6) : revérifiées par le worker avec les droits GitHub, et une approbation
// ne compte qu'une fois, qu'elle vienne du web ou de GitHub.

let t: TestDatabase;
let github: FakeGitHub;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.db.execute(sql`truncate tasks, outbox, events, commands, approvals cascade`);
  github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" });
});

async function member(login: string, role: "admin" | "member" | "viewer") {
  const [user] = await t.db
    .insert(users)
    .values({
      orgId: DEFAULT_ORG_ID,
      login,
      kind: "human",
      githubUserId: Math.floor(Math.random() * 1e9),
    })
    .returning();
  await t.db.insert(memberships).values({ orgId: DEFAULT_ORG_ID, userId: user!.id, role });
  return user!;
}

async function webCommand(taskId: string, authorId: string, args: object) {
  const [row] = await t.db
    .insert(commands)
    .values({
      orgId: DEFAULT_ORG_ID,
      taskId,
      source: "web",
      authorId,
      name: (args as { name: string }).name,
      args,
      decision: "pending",
      reason: "en attente",
    })
    .returning();
  await drainWebCommands(testDeps(t.db, github));
  return (await t.db.select().from(commands).where(eq(commands.id, row!.id)))[0];
}

const awaitingSpec = async () => {
  const { task } = await seedTask(t.db, { issueNumber: 300 });
  await t.db
    .update(tasks)
    .set({ state: "awaiting_spec_approval", risk: "medium" })
    .where(eq(tasks.id, task.id));
  return task;
};

describe("commandes du web", () => {
  it("un member sans droit d'écriture sur le repo GitHub ne peut pas approuver", async () => {
    const task = await awaitingSpec();
    const mia = await member("mia", "member");
    github.setRole("mia", "read");

    const result = await webCommand(task.id, mia.id, { name: "approve" });

    expect(result).toMatchObject({ decision: "denied" });
    expect(result?.reason).toContain("write");
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe(
      "awaiting_spec_approval",
    );
  });

  it("une approbation donnée sur le web puis sur GitHub : la seconde est refusée proprement", async () => {
    const task = await awaitingSpec();
    const ana = await member("ana", "member");
    github.setRole("ana", "write");
    github.setRole("alice", "write");

    expect(await webCommand(task.id, ana.id, { name: "approve" })).toMatchObject({
      decision: "applied",
    });
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe(
      "designing",
    );

    await t.db.insert(events).values({
      orgId: DEFAULT_ORG_ID,
      deliveryId: crypto.randomUUID(),
      event: "issue_comment",
      action: "created",
      githubInstallationId: 4242,
      payload: issueComment({ body: "/jules approve", issueNumber: 300 }),
    });
    await drainEvents(testDeps(t.db, github));
    await drainOutbox(testDeps(t.db, github));

    const second = (await t.db.select().from(commands).where(eq(commands.source, "github")))[0];
    expect(second).toMatchObject({ name: "approve", decision: "rejected" });
    expect(
      github.commentsOn({ installationId: 4242, owner: "acme", repo: "sandbox" }, 300).at(-1)?.body,
    ).toContain("rien à valider");
  });

  it("répondre aux questions depuis l'app relance la tâche, comme un commentaire sur l'issue", async () => {
    const { task } = await seedTask(t.db, { issueNumber: 301 });
    await t.db
      .update(tasks)
      .set({ state: "awaiting_info", resumeState: "specifying", risk: "low" })
      .where(eq(tasks.id, task.id));
    const ana = await member("ana", "member");
    const visitor = await member("visiteur", "viewer");
    github.setRole("ana", "write");
    github.setRole("visiteur", "read");

    // Les mêmes droits que pour répondre dans l'issue : écriture sur le repo.
    expect(
      await webCommand(task.id, visitor.id, { name: "answer", text: "sub(a, b)" }),
    ).toMatchObject({ decision: "denied" });
    const answered = await webCommand(task.id, ana.id, {
      name: "answer",
      text: "Une soustraction sub(a, b) qui renvoie a - b.",
    });
    expect(answered).toMatchObject({ decision: "applied" });
    const [resumed] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(resumed).toMatchObject({ state: "specifying", resumeState: null });
    const [input] = await t.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.taskId, task.id), eq(artifacts.kind, "human_input")));
    expect(input?.content).toMatchObject({
      kind: "answer",
      text: "Une soustraction sub(a, b) qui renvoie a - b.",
    });
    // Plus de question en attente : une seconde réponse est refusée proprement.
    expect(await webCommand(task.id, ana.id, { name: "answer", text: "encore" })).toMatchObject({
      decision: "rejected",
    });
  });

  it("le rôle Jules borne aussi les droits GitHub", async () => {
    const task = await awaitingSpec();
    const vic = await member("vic", "viewer");
    github.setRole("vic", "admin");
    expect(await webCommand(task.id, vic.id, { name: "approve" })).toMatchObject({
      decision: "denied",
    });
  });

  it("une tâche créée sur le web crée son issue GitHub sans se redéclencher", async () => {
    const { task } = await seedTask(t.db, { state: "received" });
    await t.db.update(tasks).set({ issueNumber: null }).where(eq(tasks.id, task.id));
    await t.db.insert(outbox).values({
      orgId: DEFAULT_ORG_ID,
      kind: "github.create_issue",
      idempotencyKey: `task:${task.id}:issue`,
      serialKey: `task:${task.id}`,
      payload: { taskId: task.id, requester: "ana" },
    });

    await drainOutbox(testDeps(t.db, github));

    const [issue] = github.issues;
    expect(issue?.body).toContain(`jules:task=${task.id}`);
    expect(issue?.body).not.toMatch(/(^|[^\u200b])@jules/);
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.issueNumber).toBe(
      issue?.number,
    );
  });
});

describe("secrets saisis dans l'interface", () => {
  it("le worker ouvre le scellé et range le secret ; la soumission disparaît", async () => {
    const store = new SecretStore(t.db, new Keyring(parseMasterKey(generateMasterKey())));
    const key = await ensureWorkerKey(t.db, store);
    expect((await ensureWorkerKey(t.db, store)).id).toBe(key.id);
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(sodium.from_string("clé-ssh-de-prod"), key.publicKey);
    await t.db.insert(secretSubmissions).values({
      orgId: DEFAULT_ORG_ID,
      name: "ssh_app_prod",
      sealed: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      workerKeyId: key.id,
    });

    expect(await drainSecretSubmissions(t.db, store)).toBe(1);

    expect((await store.get(DEFAULT_ORG_ID, "ssh_app_prod"))?.toString()).toBe("clé-ssh-de-prod");
    expect(await t.db.select().from(secretSubmissions)).toHaveLength(0);
    expect((await t.db.select().from(workerKeys)).length).toBe(1);
  });
});
