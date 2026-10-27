import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "@jules/api/app";
import {
  DEFAULT_ORG_ID,
  LOCAL_INSTALLATION_ID,
  and,
  artifacts,
  eq,
  outbox,
  registerLocalRepo,
  repos,
  tasks,
  users,
} from "@jules/db";
import { startTestDatabase } from "@jules/db/testing";
import { LocalForge, LocalMergeError } from "@jules/forge/local";

// Serveur des tests du mode local (M10) : vraie api en mode local, vraie base, vrais dossiers git.
// Le port de contrôle (4331) joue le worker pour l'effet `local.merge`, avec la vraie forge locale ;
// le pipeline complet côté worker est prouvé par apps/worker/test/sandbox-m10.test.ts.

export const LOCAL_API_PORT = 4330;
export const CONTROL_PORT = 4331;
export const LOCAL_SECRET = "secret-de-connexion-local-des-tests-e2e-0123456789";

const t = await startTestDatabase();
const root = mkdtempSync(join(tmpdir(), "jules-e2e-local-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
    .toString()
    .trim();

function folder(name: string) {
  const path = join(root, name);
  mkdirSync(join(path, "src"), { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "src", "math.js"), "export const sum = (a, b) => a + b;\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "init");
  return path;
}

// Un dossier avec une demande de merge de Jules qui attend la review humaine.
const path = folder("calculs");
const base = git(path, "rev-parse", "HEAD");
git(path, "checkout", "-q", "-b", "jules/1-mul");
writeFileSync(
  join(path, "src", "math.js"),
  "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n",
);
git(path, "commit", "-q", "-am", "feat: ajoute mul");
const head = git(path, "rev-parse", "HEAD");
const diff = git(path, "diff", base, head);
git(path, "checkout", "-q", "main");
const second = folder("site");

const repo = await registerLocalRepo(t.db, { orgId: DEFAULT_ORG_ID, path });
await t.db.update(repos).set({ autonomy: "L2" }).where(eq(repos.id, repo.id));
const forge = new LocalForge(t.db);
const ref = {
  installationId: LOCAL_INSTALLATION_ID,
  owner: "local",
  repo: repo.fullName.split("/")[1] ?? "",
};
await forge.createIssue(ref, { title: "Ajouter mul", body: "Ajoute une multiplication." });
const pr = await forge.createPullRequest(ref, {
  head: "jules/1-mul",
  base: "main",
  title: "feat: ajoute mul",
  body: "Closes #1",
  draft: false,
});
const [task] = await t.db
  .insert(tasks)
  .values({
    orgId: DEFAULT_ORG_ID,
    repoId: repo.id,
    agent: "developer",
    title: "Ajouter mul",
    request: "Ajoute une multiplication.",
    state: "awaiting_human_review",
    type: "feature",
    size: "S",
    risk: "low",
    autonomy: "L2",
    issueNumber: 1,
    prNumber: pr.number,
    prUrl: pr.url,
    branch: "jules/1-mul",
    baseSha: base,
    headSha: head,
  })
  .returning();
await t.db.insert(artifacts).values({
  orgId: DEFAULT_ORG_ID,
  taskId: task!.id,
  kind: "diff",
  version: 1,
  content: { text: diff },
});

const app = await buildApi({
  db: t.db,
  pool: t.pool,
  publicUrl: `http://localhost:${LOCAL_API_PORT}`,
  adminLogins: [],
  local: {
    loginHash: createHash("sha256").update(LOCAL_SECRET).digest("base64url"),
    roots: [root],
  },
  desktopOrigins: ["http://localhost:4320"],
});
await app.listen({ port: LOCAL_API_PORT, host: "localhost" });

/** Ce que fait le worker pour `local.merge` (apps/worker/src/outbox.ts), avec la même forge. */
async function drainMerges() {
  const pending = await t.db
    .select()
    .from(outbox)
    .where(and(eq(outbox.kind, "local.merge"), eq(outbox.status, "pending")));
  for (const effect of pending) {
    const { userId } = effect.payload as { userId: string };
    const [user] = await t.db.select().from(users).where(eq(users.id, userId));
    let result: object;
    try {
      result = {
        operation: "merged",
        ...(await forge.merge(ref, pr.number, { login: user?.login ?? "jules" })),
      };
    } catch (error) {
      if (!(error instanceof LocalMergeError)) throw error;
      result = { operation: "refused", reason: error.message };
    }
    await t.db.update(outbox).set({ status: "done", result }).where(eq(outbox.id, effect.id));
  }
  return pending.length;
}

const control = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const reply = (value: unknown) => res.end(JSON.stringify(value));
  if (req.url === "/__setup") {
    reply({ taskId: task!.id, second });
  } else if (req.url === "/__drain" && req.method === "POST") {
    void drainMerges().then((count) => reply({ count }));
  } else if (req.url === "/__folder") {
    reply({ main: git(path, "log", "-1", "--format=%an %s", "main") });
  } else {
    res.statusCode = 404;
    reply({});
  }
});
await new Promise<void>((r) => control.listen(CONTROL_PORT, "127.0.0.1", r));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => control.close())
      .then(() => t.stop())
      .then(() => process.exit(0));
  });
}
