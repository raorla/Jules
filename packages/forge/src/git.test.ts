import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedPaths,
  clonePristine,
  createWorkspace,
  git,
  importBundle,
  pushBranch,
  remoteBranchSha,
  revParse,
} from "./git.js";

function tempRemote() {
  const root = mkdtempSync(join(tmpdir(), "jules-git-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  writeFileSync(join(seed, "README.md"), "# sandbox\n");
  execFileSync("git", [
    "-C",
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "init",
  ]);
  execFileSync("git", ["-C", seed, "add", "."]);
  execFileSync("git", [
    "-C",
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "-m",
    "readme",
  ]);
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);
  return { root, remote };
}

function agentCommit(workspace: string, file: string, content: string) {
  writeFileSync(join(workspace, file), content);
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=a",
    "-c",
    "user.email=a@a",
    "commit",
    "--quiet",
    "-m",
    `feat: ${file}`,
  ]);
}

describe("git du worker", () => {
  it("clone, importe un bundle, pousse sans forcer, et reste idempotent", async () => {
    const { root, remote } = tempRemote();
    const pristine = join(root, "pristine.git");
    await clonePristine(remote, pristine);
    const base = await revParse(pristine, "refs/heads/main");
    const workspace = join(root, "workspace");
    await createWorkspace(pristine, workspace, base);
    agentCommit(workspace, "health.ts", "export const ok = true;\n");
    const bundle = join(root, "work.bundle");
    execFileSync("git", [
      "-C",
      workspace,
      "bundle",
      "create",
      "--quiet",
      bundle,
      "HEAD",
      `^${base}`,
    ]);

    const head = await importBundle(pristine, bundle, "jules/1-health");
    expect(await changedPaths(pristine, base, head)).toEqual(["health.ts"]);

    await pushBranch(pristine, remote, "jules/1-health");
    await pushBranch(pristine, remote, "jules/1-health");
    expect(await remoteBranchSha(remote, "jules/1-health")).toBe(head);
    expect(await remoteBranchSha(remote, "absente")).toBeUndefined();
  });

  it("refuse de réécrire une branche déjà poussée (pas de force-push)", async () => {
    const { root, remote } = tempRemote();
    const pristine = join(root, "pristine.git");
    await clonePristine(remote, pristine);
    const base = await revParse(pristine, "refs/heads/main");
    for (const [i, content] of ["v1", "v2"].entries()) {
      const workspace = join(root, `ws${i}`);
      await createWorkspace(pristine, workspace, base);
      agentCommit(workspace, "a.txt", content);
      const bundle = join(root, `b${i}.bundle`);
      execFileSync("git", [
        "-C",
        workspace,
        "bundle",
        "create",
        "--quiet",
        bundle,
        "HEAD",
        `^${base}`,
      ]);
      await importBundle(pristine, bundle, "jules/2-x");
      if (i === 0) {
        await pushBranch(pristine, remote, "jules/2-x");
      }
    }
    await expect(pushBranch(pristine, remote, "jules/2-x")).rejects.toThrow(
      /rejected|non-fast-forward|fetch first/,
    );
  });

  it("n'exécute pas le fsmonitor ni les hooks d'un dépôt piégé", async () => {
    const { root } = tempRemote();
    const trapped = join(root, "trapped");
    execFileSync("git", ["init", "--quiet", trapped]);
    const marker = join(root, "PWNED");
    execFileSync("git", ["-C", trapped, "config", "core.fsmonitor", `touch ${marker}; false`]);
    execFileSync("git", ["-C", trapped, "config", "core.hooksPath", join(root, "hooks")]);

    await git(["status", "--porcelain"], { cwd: trapped });

    expect(existsSync(marker)).toBe(false);
  });

  it("ne laisse jamais le jeton dans un message d'erreur", async () => {
    const token = "ghs_secretjetondetest00000000000000000000";
    await expect(git(["ls-remote", `/inexistant/${token}`], { token })).rejects.not.toThrow(token);
  });
});
