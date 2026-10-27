import { verifyAuditChain } from "@jules/audit";
import { DEFAULT_ORG_ID, auditLog, eq, events, installations, outbox, sql, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { FakeGitHub } from "@jules/forge/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainEvents } from "../src/inbox.js";
import { statusMarker } from "../src/messages.js";
import { drainOutbox } from "../src/outbox.js";
import { issueComment, repo } from "./fixtures.js";
import { storeEvent, testDeps } from "./harness.js";

let t: TestDatabase;
let github: FakeGitHub;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  // Les tâches actives sont uniques par issue : on repart d'une base vide de tâches.
  await t.db.execute(sql`truncate tasks, outbox, events, users, repos, installations cascade`);
  github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" });
  github.setRole("alice", "write");
  github.setRole("bob", "read");
});

const deps = () => testDeps(t.db, github);
const allTasks = () => t.db.select().from(tasks);

describe("de l'événement au commentaire de statut", () => {
  it("crée la tâche et publie un commentaire de statut", async () => {
    const event = await storeEvent(
      t.db,
      "issue_comment",
      issueComment({ body: "@jules ajoute /healthz" }),
    );

    expect(await drainEvents(deps())).toBe(1);
    const [task] = await allTasks();
    expect(task).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      agent: "developer",
      state: "received",
      issueNumber: 1,
      request: "@jules ajoute /healthz",
      sourceEventId: event.id,
    });
    const [stored] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(stored?.status).toBe("processed");

    expect(await drainOutbox(deps())).toBe(1);
    const comments = github.commentsOn(repo, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(statusMarker(task!.id));
    expect(comments[0]?.body).toContain("`reçue` · 1/9 · Réception");
    const [updated] = await allTasks();
    expect(updated?.statusCommentId).toBe(comments[0]?.id);
  });

  it("journalise la création avec des identifiants internes seulement", async () => {
    await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    await drainEvents(deps());
    const [task] = await allTasks();

    // Le journal est append-only : il garde aussi les lignes des tests précédents.
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.targetId, task!.id));
    expect(rows.map((r) => r.action)).toEqual(["task.created"]);
    expect(JSON.stringify(rows)).not.toContain("alice");
    expect((await verifyAuditChain(t.db, DEFAULT_ORG_ID)).ok).toBe(true);
  });

  it("ne crée rien de plus quand un événement est retraité", async () => {
    const event = await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    await drainEvents(deps());
    await t.db.update(events).set({ status: "received" }).where(eq(events.id, event.id));

    await drainEvents(deps());

    expect(await allTasks()).toHaveLength(1);
    expect(await t.db.select().from(outbox)).toHaveLength(1);
  });

  it("refuse une personne sans droit d'écriture sur le repo", async () => {
    const event = await storeEvent(
      t.db,
      "issue_comment",
      issueComment({ body: "@jules go", login: "bob" }),
    );

    await drainEvents(deps());

    expect(await allTasks()).toHaveLength(0);
    const [stored] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(stored).toMatchObject({ status: "ignored", lastError: "insufficient_permission" });
    const denied = await t.db.select().from(auditLog).where(eq(auditLog.action, "trigger.denied"));
    expect(denied.at(-1)?.data).toMatchObject({ role: "read", required: "write", issue: 1 });
  });

  it("ne crée pas une seconde tâche sur une issue déjà en cours", async () => {
    await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    const second = await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules encore" }));

    await drainEvents(deps());

    expect(await allTasks()).toHaveLength(1);
    const [stored] = await t.db.select().from(events).where(eq(events.id, second.id));
    expect(stored?.lastError).toBe("task_already_active");
  });

  it("retrouve son commentaire après un crash au lieu d'en créer un second", async () => {
    await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    await drainEvents(deps());
    await drainOutbox(deps());
    // Crash simulé : le commentaire existe sur GitHub, mais ni son id ni l'effet terminé n'ont été enregistrés.
    await t.db.update(tasks).set({ statusCommentId: null });
    await t.db.update(outbox).set({ status: "pending", doneAt: null });

    await drainOutbox(deps());

    expect(github.commentsOn(repo, 1)).toHaveLength(1);
    const [effect] = await t.db.select().from(outbox);
    expect(effect?.result).toMatchObject({ operation: "found" });
  });

  it("n'édite jamais le commentaire d'une personne qui a recopié le marqueur", async () => {
    await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    await drainEvents(deps());
    const [task] = await allTasks();
    github.addHumanComment(repo, 1, `${statusMarker(task!.id)} faux statut`);

    await drainOutbox(deps());

    const comments = github.commentsOn(repo, 1);
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toBe(`${statusMarker(task!.id)} faux statut`);
  });

  it("réessaie plus tard un effet en échec", async () => {
    await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    await drainEvents(deps());
    github.failNext("createIssueComment");

    await drainOutbox(deps());

    const [failed] = await t.db.select().from(outbox);
    expect(failed).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "GitHub indisponible (createIssueComment)",
    });
    expect(failed!.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(github.commentsOn(repo, 1)).toHaveLength(0);

    await t.db.update(outbox).set({ runAfter: sql`now()` });
    await drainOutbox(deps());

    expect((await t.db.select().from(outbox))[0]?.status).toBe("done");
    expect(github.commentsOn(repo, 1)).toHaveLength(1);
  });

  it("réessaie un événement quand GitHub ne répond pas", async () => {
    const event = await storeEvent(t.db, "issue_comment", issueComment({ body: "@jules go" }));
    github.failNext("getRepoRole");

    await drainEvents(deps());

    const [stored] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(stored).toMatchObject({ status: "received", attempts: 1 });
    expect(await allTasks()).toHaveLength(0);

    await t.db.update(events).set({ lockedUntil: null });
    await drainEvents(deps());
    expect(await allTasks()).toHaveLength(1);
  });

  it("enregistre l'installation et sa suppression", async () => {
    const installation = { id: 4242, account: { login: "acme", type: "Organization" } };
    await storeEvent(t.db, "installation", { action: "created", installation } as {
      action: string;
    });
    await storeEvent(t.db, "installation", { action: "deleted", installation } as {
      action: string;
    });

    await drainEvents(deps());

    const [row] = await t.db.select().from(installations);
    expect(row).toMatchObject({ githubInstallationId: 4242, accountLogin: "acme" });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("arrêt d'urgence depuis GitHub (/jules stop-all)", () => {
  it("est réservé aux admins", async () => {
    const calls: string[] = [];
    github.setRole("carol", "admin");
    const withEmergency = {
      ...deps(),
      emergency: {
        stopAll: (actorId: string) => {
          calls.push(actorId);
          return Promise.resolve({ revokedTokens: 0, killedContainers: 0 });
        },
      },
    };

    await storeEvent(
      t.db,
      "issue_comment",
      issueComment({ body: "/jules stop-all", login: "alice" }),
    );
    await drainEvents(withEmergency);
    expect(calls).toEqual([]);

    await storeEvent(
      t.db,
      "issue_comment",
      issueComment({ body: "/jules stop-all", login: "carol" }),
    );
    await drainEvents(withEmergency);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^github:\d+$/);
  });
});
