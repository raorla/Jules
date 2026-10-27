import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORG_ID, artifacts, commands, eq, events, sql, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { FakeGitHub } from "@jules/forge/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { detectStack, missingRules, renderCodeowners, renderRepoConfig } from "../src/setup.js";
import { parseRepoConfig } from "@jules/config";
import { INSTALLATION_ID, issueComment } from "./fixtures.js";
import { seedTask, testDeps } from "./harness.js";

// Boucle humaine de M4 : /jules fix dans la PR, review « Request changes », PR fermée, @jules setup.

let t: TestDatabase;
let github: FakeGitHub;
const ref = { installationId: INSTALLATION_ID, owner: "acme", repo: "sandbox" };

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.db.execute(sql`truncate tasks, outbox, events, commands, approvals cascade`);
  github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" });
  github.setRole("alice", "write");
  github.setRole("bob", "read");
  github.setRole("mona", "maintain");
});

const deps = () => testDeps(t.db, github);

async function awaitingReview() {
  const { task } = await seedTask(t.db);
  await t.db
    .update(tasks)
    .set({ state: "awaiting_human_review", prNumber: 501, branch: "jules/x", headSha: "abc" })
    .where(eq(tasks.id, task.id));
  return task;
}

const repository = {
  id: 99,
  name: "sandbox",
  full_name: "acme/sandbox",
  private: true,
  default_branch: "main",
  owner: { id: 1, login: "acme", type: "Organization" },
};
const user = (login: string, type = "User") => ({ id: login.length * 1000 + 7, login, type });

async function store(event: string, payload: object) {
  await t.db.insert(events).values({
    orgId: DEFAULT_ORG_ID,
    deliveryId: crypto.randomUUID(),
    event,
    action: (payload as { action: string }).action,
    githubInstallationId: INSTALLATION_ID,
    payload,
  });
}

const state = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0];

describe("retour humain sur la PR", () => {
  it("/jules fix dans la PR relance le développeur sur la même branche", async () => {
    const task = await awaitingReview();
    await store("issue_comment", {
      ...issueComment({
        body: "/jules fix renomme health en status",
        issueNumber: 501,
        onPullRequest: true,
      }),
    });

    await drainEvents(deps());

    expect((await state(task.id))?.state).toBe("building");
    const [input] = await t.db.select().from(artifacts).where(eq(artifacts.kind, "human_input"));
    expect(input?.content).toMatchObject({ kind: "fix", text: "renomme health en status" });
  });

  it("une review « Request changes » d'une personne autorisée relance le développeur, avec ses commentaires", async () => {
    const task = await awaitingReview();
    github.humanReviewComments.set(77, [
      { path: "health.js", line: 1, body: "gère la base coupée" },
    ]);
    await store("pull_request_review", {
      action: "submitted",
      installation: { id: INSTALLATION_ID },
      repository,
      sender: user("alice"),
      pull_request: { number: 501 },
      review: { id: 77, state: "changes_requested", body: "Presque.", user: user("alice") },
    });

    await drainEvents(deps());

    expect((await state(task.id))?.state).toBe("building");
    const [input] = await t.db.select().from(artifacts).where(eq(artifacts.kind, "human_input"));
    expect((input?.content as { text: string }).text).toBe(
      "Presque.\n- health.js:1 : gère la base coupée",
    );
  });

  it("ignore la review d'une personne sans droit d'écriture", async () => {
    const task = await awaitingReview();
    await store("pull_request_review", {
      action: "submitted",
      installation: { id: INSTALLATION_ID },
      repository,
      sender: user("bob"),
      pull_request: { number: 501 },
      review: { id: 78, state: "changes_requested", body: "non", user: user("bob") },
    });

    await drainEvents(deps());

    expect((await state(task.id))?.state).toBe("awaiting_human_review");
    expect((await t.db.select().from(commands))[0]).toMatchObject({
      name: "request_changes",
      decision: "denied",
    });
  });

  it("une PR mergée passe au retour d'expérience ; fermée pendant le travail, la tâche est annulée", async () => {
    const merged = await awaitingReview();
    await store("pull_request", {
      action: "closed",
      installation: { id: INSTALLATION_ID },
      repository,
      sender: user("alice"),
      pull_request: { number: 501, merged: true },
    });
    await drainEvents(deps());
    expect((await state(merged.id))?.state).toBe("learning");

    const { task } = await seedTask(t.db);
    await t.db.update(tasks).set({ state: "building", prNumber: 502 }).where(eq(tasks.id, task.id));
    await store("pull_request", {
      action: "closed",
      installation: { id: INSTALLATION_ID },
      repository,
      sender: user("alice"),
      pull_request: { number: 502, merged: false },
    });
    await drainEvents(deps());
    expect(await state(task.id)).toMatchObject({
      state: "cancelled",
      lastError: "PR fermée sur GitHub",
    });
  });
});

describe("@jules setup", () => {
  function nodeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "jules-setup-remote-"));
    const remote = join(root, "sandbox.git");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "-q", remote, seed]);
    writeFileSync(
      join(seed, "package.json"),
      JSON.stringify({
        name: "x",
        scripts: { build: "tsc", test: "vitest run --coverage", lint: "eslint ." },
      }),
    );
    writeFileSync(join(seed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", [
      "-C",
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
    return remote;
  }

  it("ouvre une PR d'onboarding avec la config, AGENTS.md, les CODEOWNERS et les règles manquantes", async () => {
    const remote = nodeRepo();
    github.remotes.set("acme/sandbox", remote);
    github.branchRules = [
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 1, require_code_owner_review: false },
      },
    ];
    await store(
      "issue_comment",
      issueComment({ body: "@jules setup", login: "mona", issueNumber: 900 }),
    );

    await drainEvents(deps());
    await drainOutbox(deps());

    const pr = github.pullRequests.find((p) => p.head === "jules/setup");
    expect(pr).toMatchObject({ draft: false, base: "main" });
    expect(pr?.body).toContain("Node.js (pnpm)");
    expect(pr?.body).toContain("- [ ] exiger la review des CODEOWNERS");
    expect(pr?.body).toContain("- [ ] exiger le check `Jules / gates`");
    const config = execFileSync("git", [
      "-C",
      remote,
      "show",
      "jules/setup:.jules/config.yml",
    ]).toString();
    expect(parseRepoConfig(config)).toMatchObject({
      errors: [],
      config: {
        commands: {
          install: "pnpm install --frozen-lockfile",
          build: "pnpm build",
          test: "pnpm test",
        },
      },
    });
    expect(
      execFileSync("git", ["-C", remote, "show", "jules/setup:.github/CODEOWNERS"]).toString(),
    ).toContain("/.jules/                 @mona");
    expect(
      execFileSync("git", ["-C", remote, "show", "jules/setup:AGENTS.md"]).toString(),
    ).toContain("`pnpm test`");
    expect(github.commentsOn(ref, 900).at(-1)?.body).toContain("onboarding proposé dans");
  });

  it("est réservé à maintain et plus", async () => {
    await store(
      "issue_comment",
      issueComment({ body: "@jules setup", login: "alice", issueNumber: 901 }),
    );
    await drainEvents(deps());
    await drainOutbox(deps());
    expect(github.pullRequests).toHaveLength(0);
  });
});

describe("onboarding : détection et règles", () => {
  const files = (entries: Record<string, string>) => ({
    has: (p: string) => p in entries,
    read: (p: string) => entries[p],
  });

  it("détecte les stacks courantes et produit une config valide", () => {
    expect(detectStack(files({ "package.json": "{}", "package-lock.json": "{}" }))?.install).toBe(
      "npm ci",
    );
    expect(detectStack(files({ "pyproject.toml": "[tool.ruff]" }))).toMatchObject({
      name: "Python",
      lint: "ruff check .",
    });
    expect(detectStack(files({ "go.mod": "" }))?.test).toBe("go test ./...");
    expect(detectStack(files({ "Cargo.toml": "" }))?.name).toBe("Rust");
    expect(detectStack(files({}))).toBeUndefined();
    for (const stack of [detectStack(files({ "go.mod": "" })), undefined]) {
      expect(parseRepoConfig(renderRepoConfig(stack, "fr")).errors).toEqual([]);
    }
    expect(renderCodeowners("mona")).toContain("/.github/                @mona");
  });

  it("liste les règles de branche manquantes", () => {
    expect(missingRules([])).toEqual([
      "exiger une pull request avant de merger",
      "exiger le check `Jules / gates`",
      "exiger le check `Jules / review`",
      "bloquer les force-push",
    ]);
    expect(
      missingRules([
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 1, require_code_owner_review: true },
        },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "Jules / gates" }, { context: "Jules / review" }],
          },
        },
        { type: "non_fast_forward" },
      ]),
    ).toEqual([]);
  });
});
