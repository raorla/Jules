import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { DEFAULT_ORG_ID, installations, repos, servers, type Db } from "@jules/db";
import { Keyring, SecretStore, generateMasterKey, parseMasterKey } from "@jules/secrets";
import { probeHostKey } from "@jules/ssh";
import { generateTestKeyPair, startTestSshServer, type TestSshServer } from "@jules/ssh/testing";
import pino from "pino";
import { Masker } from "../src/broker/masking.js";
import { DeploymentService } from "../src/devops/deployments.js";
import { PlanService } from "../src/devops/plans.js";
import { ServerService, sshKeyName } from "../src/devops/servers.js";
import type { GitHubApp } from "@jules/forge";

// Banc DevOps : vrais serveurs OpenSSH (images/ssh-test), vraie base, vrai coffre de secrets.
// Le journal du worker est gardé en mémoire pour vérifier qu'aucune clé n'y apparaît.

export const SSH_KEYS = generateTestKeyPair();

export function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  return { log: pino({ level: "debug" }, stream), lines };
}

export type DevopsBench = ReturnType<typeof devopsBench>;

export function devopsBench(
  db: Db,
  options: { github?: GitHubApp; runsDir?: string; httpRetryMs?: number } = {},
) {
  const masterKey = generateMasterKey();
  const store = new SecretStore(db, new Keyring(parseMasterKey(masterKey)));
  const masker = new Masker(["sk-ant-api03-cle-du-worker-0123456789abcdef"]);
  const { log, lines } = captureLogger();
  const serverService = new ServerService({
    db,
    secrets: store,
    masker,
    log,
    commandTimeoutSec: 30,
  });
  let deployments: DeploymentService | undefined;
  const plans = new PlanService({
    db,
    servers: serverService,
    log,
    httpRetryMs: options.httpRetryMs ?? 200,
    onFinished: (tx, plan, outcome) =>
      deployments?.onPlanFinished(tx, plan, outcome) ?? Promise.resolve(),
  });
  if (options.github) {
    deployments = new DeploymentService({
      db,
      github: options.github,
      plans,
      servers: serverService,
      log,
      runsDir: options.runsDir ?? mkdtempSync(join(tmpdir(), "jules-deploy-")),
    });
  }
  const sshd: TestSshServer[] = [];

  async function repo(githubRepoId = 99, fullName = "acme/sandbox") {
    const [installation] = await db
      .insert(installations)
      .values({
        orgId: DEFAULT_ORG_ID,
        githubInstallationId: 4242,
        accountLogin: "acme",
        accountType: "Organization",
      })
      .onConflictDoUpdate({
        target: installations.githubInstallationId,
        set: { accountLogin: "acme" },
      })
      .returning();
    const [row] = await db
      .insert(repos)
      .values({
        orgId: DEFAULT_ORG_ID,
        forge: "github",
        installationId: installation!.id,
        githubRepoId,
        fullName,
        defaultBranch: "main",
        private: true,
      })
      .onConflictDoUpdate({ target: [repos.forge, repos.githubRepoId], set: { fullName } })
      .returning();
    return row!;
  }

  /** Un serveur prêt : clé d'hôte lue et validée, clé privée scellée dans le coffre. */
  async function addServer(input: {
    name: string;
    environment: "development" | "staging" | "production";
    level: "D0" | "D1" | "D2" | "D3";
    repoId?: string;
    host?: TestSshServer;
  }) {
    const host = input.host ?? (await startTestSshServer(SSH_KEYS.publicKey));
    if (!input.host) {
      sshd.push(host);
    }
    const hostKey = await probeHostKey(host);
    const [row] = await db
      .insert(servers)
      .values({
        orgId: DEFAULT_ORG_ID,
        name: input.name,
        host: host.host,
        port: host.port,
        username: host.username,
        environment: input.environment,
        level: input.level,
        repoId: input.repoId ?? null,
        hostKeyStatus: "trusted",
        hostKeyFingerprint: hostKey.fingerprint,
        offeredFingerprint: hostKey.fingerprint,
      })
      .returning();
    await store.set(DEFAULT_ORG_ID, sshKeyName(row!.id), SSH_KEYS.privateKey);
    return { server: row!, host };
  }

  return {
    store,
    masterKey,
    masker,
    log,
    lines,
    servers: serverService,
    plans,
    get deployments() {
      if (!deployments) {
        throw new Error("banc sans GitHub : pas de déploiements");
      }
      return deployments;
    },
    repo,
    addServer,
    async stop() {
      await Promise.all(sshd.map((s) => s.stop()));
    },
  };
}

/** Dépôt nu local qui joue le rôle du repo GitHub, avec les fichiers donnés sur main. */
export function remoteWithFiles(files: Record<string, string>): {
  remote: string;
  commit: (files: Record<string, string>) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "jules-remote-"));
  const remote = join(root, "repo.git");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  const commit = (content: Record<string, string>) => {
    for (const [path, text] of Object.entries(content)) {
      mkdirSync(dirname(join(seed, path)), { recursive: true });
      writeFileSync(join(seed, path), text);
    }
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
      "--allow-empty",
      "-m",
      "commit",
    ]);
    execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "HEAD:main"]);
    return execFileSync("git", ["-C", seed, "rev-parse", "HEAD"]).toString().trim();
  };
  commit(files);
  return { remote, commit };
}
