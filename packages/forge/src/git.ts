import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git côté worker (ARCHITECTURE.md §5, §8, §12). Règles :
// - git ne tourne jamais sur l'hôte dans un workspace modifié par l'agent : seulement dans le clone
//   « pristine » du worker, jamais monté dans un sandbox ;
// - le jeton d'installation passe par GIT_ASKPASS et une variable propre au processus git, jamais
//   par la ligne de commande ni par .git/config ;
// - jamais de force-push.

export class GitError extends Error {
  override readonly name = "GitError";
}

/** Options forcées sur chaque appel : aucun hook, aucun programme externe, aucune invite. */
const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.ext.allow=never",
];

let askpassScript: Promise<string> | undefined;

/** Script GIT_ASKPASS : il renvoie le jeton lu dans l'environnement du seul processus git. */
function askpass(): Promise<string> {
  askpassScript ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "jules-askpass-"));
    const path = join(dir, "askpass.sh");
    await writeFile(
      path,
      '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo "$JULES_GIT_TOKEN" ;;\nesac\n',
    );
    await chmod(path, 0o700);
    return path;
  })();
  return askpassScript;
}

export type GitOptions = { cwd?: string; token?: string; timeoutMs?: number };

export async function git(args: readonly string[], options: GitOptions = {}): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
  if (options.token) {
    env.GIT_ASKPASS = await askpass();
    env.JULES_GIT_TOKEN = options.token;
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      { cwd: options.cwd, env, timeout: options.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const redacted = options.token ? stderr.split(options.token).join("[masqué]") : stderr;
          reject(new GitError(`git ${args[0] ?? ""} : ${redacted.trim() || error.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Clone nu du worker : la seule copie sur laquelle git tourne sur l'hôte. */
export async function clonePristine(remoteUrl: string, dir: string, token?: string): Promise<void> {
  try {
    await git(["clone", "--bare", "--quiet", remoteUrl, dir], { ...(token ? { token } : {}) });
  } catch (error) {
    // Mode local : pour un dossier ordinaire, git dit « does not exist », ce qui n'aide personne.
    if (isLocalRemote(remoteUrl) && error instanceof GitError) {
      throw new GitError(
        `le dossier ${remoteUrl} n'est pas un dépôt git utilisable : lance git init et fais un premier commit dedans, ou choisis un autre dossier (${error.message})`,
      );
    }
    throw error;
  }
}

export async function revParse(repoDir: string, ref: string): Promise<string> {
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoDir })).trim();
}

/** Workspace de l'agent, cloné depuis le pristine et positionné sur la base. */
export async function createWorkspace(
  pristineDir: string,
  workspaceDir: string,
  baseSha: string,
): Promise<void> {
  await git(["clone", "--quiet", "--no-hardlinks", pristineDir, workspaceDir]);
  await git(["checkout", "--quiet", "--detach", baseSha], { cwd: workspaceDir });
  await git(["remote", "remove", "origin"], { cwd: workspaceDir });
}

/** Importe les commits de l'agent, exportés dans un conteneur par `git bundle`. */
export async function importBundle(
  pristineDir: string,
  bundlePath: string,
  branch: string,
): Promise<string> {
  await git(["bundle", "verify", "--quiet", bundlePath], { cwd: pristineDir });
  await git(["fetch", "--quiet", "--no-tags", bundlePath, `+HEAD:refs/heads/${branch}`], {
    cwd: pristineDir,
  });
  return revParse(pristineDir, `refs/heads/${branch}`);
}

export async function changedPaths(repoDir: string, base: string, head: string): Promise<string[]> {
  const out = await git(
    ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", base, head],
    {
      cwd: repoDir,
    },
  );
  return out.split("\0").filter(Boolean);
}

export async function remoteBranchSha(
  remoteUrl: string,
  branch: string,
  token?: string,
): Promise<string | undefined> {
  const out = await git(["ls-remote", "--heads", remoteUrl, `refs/heads/${branch}`], {
    ...(token ? { token } : {}),
  });
  return out.split(/\s+/)[0] || undefined;
}

/** Pousse une branche sans jamais forcer. Idempotent : pousser le même SHA ne change rien. */
export async function pushBranch(
  pristineDir: string,
  remoteUrl: string,
  branch: string,
  token?: string,
): Promise<void> {
  await git(
    [
      "push",
      "--quiet",
      "--no-verify",
      ...(isLocalRemote(remoteUrl) ? [`--receive-pack=${LOCAL_RECEIVE_PACK}`] : []),
      remoteUrl,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    {
      cwd: pristineDir,
      ...(token ? { token } : {}),
    },
  );
}

/** Dossier de la machine (mode local), par opposition à une URL `https://` ou `ssh://`. */
export function isLocalRemote(remoteUrl: string): boolean {
  return !/^[a-z][\w+.-]*:\/\//i.test(remoteUrl) && !/^[\w.-]+@[\w.-]+:/.test(remoteUrl);
}

/**
 * Pousser vers un dossier local lance `git receive-pack` dans ce dossier, avec sa propre config :
 * les options `-c` du worker ne lui sont pas transmises. Sans cette commande, un hook `post-receive`
 * versionné (un `core.hooksPath` absolu vers le dossier de travail), écrit par l'agent sur sa branche
 * puis extrait par la personne, s'exécuterait dans le worker.
 */
const LOCAL_RECEIVE_PACK =
  "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.autogc=false receive-pack";

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Contenu d'un fichier à un commit du pristine (config et conventions, lues sur la branche par défaut). */
export async function readFileAt(
  repoDir: string,
  sha: string,
  path: string,
  maxBytes = 200_000,
): Promise<string | undefined> {
  try {
    const size = Number((await git(["cat-file", "-s", `${sha}:${path}`], { cwd: repoDir })).trim());
    if (!Number.isFinite(size) || size > maxBytes) {
      return undefined;
    }
    return await git(["show", `${sha}:${path}`], { cwd: repoDir });
  } catch {
    return undefined;
  }
}
