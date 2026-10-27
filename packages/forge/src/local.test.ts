import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ORG_ID,
  LOCAL_INSTALLATION_ID,
  eq,
  events,
  localItems,
  registerLocalRepo,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clonePristine, isLocalRemote, pushBranch } from "./git.js";
import { LocalForge, LocalMergeError } from "./local.js";

// Forge locale (M10) sur une vraie base et de vrais dossiers git.

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.stop();
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
    .toString()
    .trim();

/** Dossier de travail d'une personne : un vrai repo, avec main extraite. */
function workingRepo(name = "projet"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "jules-local-")), name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# projet\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Ce que fait le worker : clone nu, commit sur une branche jules/*, push vers le dossier. */
async function pushFeature(path: string, branch: string, files: Record<string, string>) {
  const pristine = join(mkdtempSync(join(tmpdir(), "jules-pristine-")), "p.git");
  await clonePristine(path, pristine);
  const work = mkdtempSync(join(tmpdir(), "jules-work-"));
  execFileSync("git", ["clone", "-q", pristine, work]);
  sh(work, "checkout", "-q", "-b", branch);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), content);
    if (file.includes("hooks/")) {
      chmodSync(join(work, file), 0o755);
    }
  }
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", `feat: ${branch}`);
  sh(work, "push", "-q", "origin", branch);
  await pushBranch(pristine, path, branch);
  return sh(path, "rev-parse", `refs/heads/${branch}`);
}

async function setup(name?: string) {
  const path = workingRepo(name);
  const repo = await registerLocalRepo(t.db, { orgId: DEFAULT_ORG_ID, path });
  const forge = new LocalForge(t.db);
  const [owner, repoName] = repo.fullName.split("/") as [string, string];
  return {
    path,
    repo,
    forge,
    ref: { installationId: LOCAL_INSTALLATION_ID, owner, repo: repoName },
  };
}

describe("repos locaux", () => {
  it("un dossier n'est enregistré qu'une fois, avec un identifiant négatif et un nom unique", async () => {
    const a = workingRepo("app");
    const b = workingRepo("app");
    const first = await registerLocalRepo(t.db, { orgId: DEFAULT_ORG_ID, path: a });
    const again = await registerLocalRepo(t.db, { orgId: DEFAULT_ORG_ID, path: a });
    const other = await registerLocalRepo(t.db, { orgId: DEFAULT_ORG_ID, path: b });
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ forge: "local", fullName: "local/app", private: true });
    expect(other.fullName).toBe("local/app-2");
    expect(first.githubRepoId).toBeLessThan(0);
    expect(other.githubRepoId).toBeLessThan(first.githubRepoId!);
  });

  it("le port reconnaît les chemins locaux et les sépare des URL distantes", () => {
    expect(isLocalRemote("/home/a/projet")).toBe(true);
    expect(isLocalRemote("C:\\Users\\a\\projet")).toBe(true);
    expect(isLocalRemote("https://github.com/acme/app.git")).toBe(false);
    expect(isLocalRemote("git@github.com:acme/app.git")).toBe(false);
  });
});

describe("forge locale", () => {
  it("issues et demandes de merge partagent la suite de numéros ; commentaires, reviews et checks", async () => {
    const { forge, ref } = await setup();
    const issue = await forge.createIssue(ref, { title: "Bug", body: "x <!-- m:1 -->" });
    const pr = await forge.createPullRequest(ref, {
      head: "jules/1-bug",
      base: "main",
      title: "Corrige le bug",
      body: "Closes #1",
      draft: true,
    });
    expect(issue.number).toBe(1);
    expect(pr).toMatchObject({ number: 2, url: "local:projet#2", draft: true });
    expect(await forge.findIssueByMarker(ref, "<!-- m:1 -->")).toEqual({ number: 1 });
    expect((await forge.findPullRequest(ref, "jules/1-bug"))?.number).toBe(2);

    const comment = await forge.createIssueComment(ref, 1, "statut <!-- s -->");
    expect(await forge.findIssueComment(ref, 1, "<!-- s -->")).toEqual({ id: comment.id });
    expect(await forge.updateIssueComment(ref, comment.id, "nouveau <!-- s -->")).toBe(true);
    expect(await forge.updateIssueComment(ref, 999_999, "x")).toBe(false);

    const review = await forge.createReview(ref, 2, {
      commitId: "abc",
      body: "avis <!-- r -->",
      comments: [{ path: "a.js", line: 3, body: "nom" }],
    });
    expect(await forge.findReview(ref, 2, "<!-- r -->")).toEqual({ id: review.id });
    expect(await forge.listReviewComments(ref, 2, review.id)).toEqual([
      { path: "a.js", line: 3, body: "nom" },
    ]);

    await forge.upsertCheckRun(ref, {
      name: "Jules / gates",
      headSha: "abc",
      status: "in_progress",
      title: "en cours",
      summary: "",
    });
    await forge.upsertCheckRun(ref, {
      name: "Jules / gates",
      headSha: "abc",
      status: "completed",
      conclusion: "success",
      title: "ok",
      summary: "tout passe",
    });
    expect(await forge.listCheckRuns(ref, "abc")).toEqual([
      expect.objectContaining({
        name: "Jules / gates",
        status: "completed",
        conclusion: "success",
      }),
    ]);

    await forge.markReadyForReview(ref, pr);
    expect((await forge.findPullRequest(ref, "jules/1-bug"))?.draft).toBe(false);
    await forge.closeIssue(ref, 1);
    const [closed] = await t.db.select().from(localItems).where(eq(localItems.number, 1));
    expect(closed?.state).toBe("closed");
    expect(await forge.getRepoRole()).toBe("admin");
    expect(await forge.getBranchRules()).toEqual([]);
  });

  it("cloneUrl est le dossier lui-même, connu après le jeton ou après load()", async () => {
    const { forge, ref, path } = await setup();
    expect(() => forge.cloneUrl(ref)).toThrow(/inconnu/);
    expect(await new LocalForge(t.db).load()).toBeGreaterThan(0);
    expect(await forge.getRepoToken(ref)).toBe("local");
    expect(forge.cloneUrl(ref)).toBe(path);
    const app = await forge.getApp();
    expect(app.permissions).not.toHaveProperty("workflows");
  });

  it("pousser dans le dossier n'exécute aucun hook, même versionné et extrait", async () => {
    const { path } = await setup();
    // Les hooks viennent du dossier de travail (chemin absolu : pendant un push, git exécute les
    // hooks depuis .git, où un chemin relatif ne mène pas).
    sh(path, "config", "core.hooksPath", join(path, ".husky"));
    const marker = join(path, "..", "PWNED");
    mkdirSync(join(path, ".husky"));
    for (const hook of [
      "pre-receive",
      "update",
      "post-receive",
      "post-update",
      "reference-transaction",
    ]) {
      writeFileSync(join(path, ".husky", hook), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(path, ".husky", hook), 0o755);
    }
    // Contrôle : un push git ordinaire exécute bien ces hooks.
    const control = join(mkdtempSync(join(tmpdir(), "jules-ctl-")), "c");
    execFileSync("git", ["clone", "-q", path, control]);
    sh(control, "checkout", "-q", "-b", "controle");
    sh(control, "push", "-q", "origin", "controle");
    expect(existsSync(marker)).toBe(true);
    execFileSync("rm", ["-f", marker]);

    const sha = await pushFeature(path, "jules/2-x", { "x.js": "export const x = 1;\n" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("merge humain : base extraite et propre, aucun hook, événement de merge, issue fermée", async () => {
    const { forge, ref, path, repo } = await setup();
    sh(path, "config", "core.hooksPath", ".githooks");
    const marker = join(path, "..", "PWNED-MERGE");
    const head = await pushFeature(path, "jules/3-y", {
      // L'agent glisse un hook post-merge dans sa branche : il ne doit jamais tourner.
      ".githooks/post-merge": `#!/bin/sh\ntouch "${marker}"\n`,
      "y.js": "export const y = 2;\n",
    });
    await forge.createIssue(ref, { title: "Y", body: "y" });
    const pr = await forge.createPullRequest(ref, {
      head: "jules/3-y",
      base: "main",
      title: "Ajoute y",
      body: "Fixes #1",
      draft: false,
    });

    const { sha } = await forge.merge(ref, pr.number, { login: "alice" });
    expect(sh(path, "rev-parse", "HEAD")).toBe(sha);
    expect(sh(path, "rev-parse", "HEAD^2")).toBe(head);
    expect(sh(path, "log", "-1", "--format=%an %s")).toBe("alice Merge !2 : Ajoute y");
    expect(existsSync(join(path, "y.js"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const items = await t.db.select().from(localItems).where(eq(localItems.repoId, repo.id));
    expect(items.find((i) => i.number === 1)?.state).toBe("closed");
    expect(items.find((i) => i.number === 2)).toMatchObject({ state: "merged", mergeSha: sha });
    const [event] = await t.db
      .select()
      .from(events)
      .where(eq(events.deliveryId, `local-merge-${items.find((i) => i.number === 2)!.id}`));
    expect(event?.payload).toMatchObject({
      action: "closed",
      repository: { id: repo.githubRepoId, owner: { login: "local" } },
      pull_request: { number: 2, merged: true, merge_commit_sha: sha, base: { ref: "main" } },
    });
    await expect(forge.merge(ref, pr.number, { login: "alice" })).rejects.toThrow(/déjà fermée/);

    // Contrôle : le hook mergé est bien actif pour un git ordinaire.
    sh(path, "checkout", "-q", "-b", "autre");
    writeFileSync(join(path, "w.js"), "w\n");
    sh(path, "add", "-A");
    sh(path, "commit", "-q", "-m", "w");
    sh(path, "checkout", "-q", "main");
    sh(path, "merge", "-q", "--no-ff", "-m", "m", "autre");
    expect(existsSync(marker)).toBe(true);
  });

  it("refuse de merger sur un dossier modifié ; base non extraite : la branche avance sans toucher au dossier", async () => {
    const { forge, ref, path } = await setup();
    await pushFeature(path, "jules/4-z", { "z.js": "export const z = 3;\n" });
    const pr = await forge.createPullRequest(ref, {
      head: "jules/4-z",
      base: "main",
      title: "Ajoute z",
      body: "",
      draft: false,
    });
    writeFileSync(join(path, "README.md"), "# modifié\n");
    await expect(forge.merge(ref, pr.number, { login: "alice" })).rejects.toThrow(LocalMergeError);
    await expect(forge.merge(ref, pr.number, { login: "alice" })).rejects.toThrow(/non commitées/);

    // La personne travaille sur une autre branche : main avance par compare-and-swap.
    sh(path, "checkout", "-q", "-b", "travail");
    const before = sh(path, "rev-parse", "main");
    const { sha } = await forge.merge(ref, pr.number, { login: "alice" });
    expect(sh(path, "rev-parse", "main")).toBe(sha);
    expect(sh(path, "rev-parse", `${sha}^1`)).toBe(before);
    expect(sh(path, "symbolic-ref", "--short", "HEAD")).toBe("travail");
    expect(existsSync(join(path, "z.js"))).toBe(false);
    expect(sh(path, "status", "--porcelain")).toBe("M README.md");
  });
});
