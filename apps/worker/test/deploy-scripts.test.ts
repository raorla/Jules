import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./sandbox-harness.js";

// Livrables M11 : l'installation du serveur en une commande et la montée de version. Les vrais scripts
// de deploy/, sur une copie, avec un faux `docker` qui journalise ses appels : on vérifie ce que
// chaque script fait, dans quel ordre, et ce qu'il refuse.

const FAKE_DOCKER = `#!/bin/sh
echo "docker $*" >> "$DOCKER_LOG"
case "$*" in
  "compose version") echo "Docker Compose version v2.40.0" ;;
  "version --format {{.Server.Version}}") echo "\${FAKE_DOCKER_VERSION:-28.5.1}" ;;
  "info --format "*) echo "\${FAKE_RUNTIMES:-io.containerd.runc.v2 runc runsc}" ;;
  *"run --rm backup"*) exit "\${FAKE_BACKUP_EXIT:-0}" ;;
  *"run --rm migrate"*) exit "\${FAKE_MIGRATE_EXIT:-0}" ;;
esac
exit 0
`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "jules-deploy-"));
  cpSync(join(ROOT, "deploy"), join(root, "deploy"), {
    recursive: true,
    filter: (src) => !/\/deploy\/(secrets|\.env$|backup\.env$)/.test(src),
  });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  mkdirSync(join(root, "runs"));
  const log = join(root, "docker.log");
  writeFileSync(log, "");
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    writeFileSync(log, "");
    const result = spawnSync("sh", [join(root, "deploy", script), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: root,
        DOCKER_LOG: log,
        JULES_RUNS_DIR: join(root, "runs"),
        ...env,
      },
    });
    return {
      ...result,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    };
  };
  const file = (path: string) => readFileSync(join(root, "deploy", path), "utf8");
  return { root, run, file };
}

describe("installation en une commande (M11)", () => {
  it("vérifie l'hôte, crée les secrets, remplit .env, construit et démarre la pile", () => {
    const w = workspace();
    const first = w.run("install.sh", ["--domain", "jules.example.org", "--admins", "alice,bob"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.calls).toEqual([
      "docker compose version",
      "docker version --format {{.Server.Version}}",
      "docker info --format {{range $k, $v := .Runtimes}}{{$k}} {{end}}",
      "docker compose build",
      "docker compose --profile images build",
      // Sans GitHub App, tout sauf le worker.
      "docker compose --profile caddy up -d --wait postgres migrate gateway api caddy",
    ]);
    for (const name of [
      "postgres_password",
      "github_webhook_secret",
      "restic_password",
      "jules_master_key",
    ]) {
      const path = join(w.root, "deploy", "secrets", name);
      expect(statSync(path).mode & 0o777, name).toBe(0o600);
      expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(20);
    }
    expect(statSync(join(w.root, "deploy", ".env")).mode & 0o777).toBe(0o600);
    const key = Buffer.from(w.file("secrets/jules_master_key").trim(), "base64");
    expect(key).toHaveLength(32);
    expect(w.file("secrets/database_url")).toBe(
      `postgres://jules:${w.file("secrets/postgres_password").trim()}@postgres:5432/jules`,
    );
    expect(w.file(".env")).toMatch(/^JULES_DOMAIN=jules\.example\.org$/m);
    expect(w.file(".env")).toMatch(/^JULES_ADMIN_LOGINS=alice,bob$/m);
    expect(w.file(".env")).toMatch(/^JULES_SANDBOX_RUNTIME=runsc$/m);
    // L'empreinte affichée est celle de `jules master-key fingerprint`.
    const fingerprint = createHash("sha256")
      .update("jules:kek:")
      .update(key)
      .digest("hex")
      .slice(0, 16);
    expect(first.stdout).toContain(fingerprint);

    // Relancé avec la GitHub App : les secrets sont gardés, le worker démarre avec le reste.
    const secrets = w.file("secrets/jules_master_key");
    const second = w.run("install.sh", ["--github-app-id", "123456", "--expose", "tunnel"]);
    expect(second.status, second.stderr).toBe(0);
    expect(w.file("secrets/jules_master_key")).toBe(secrets);
    expect(second.stdout).toContain("secrets/jules_master_key existe déjà, conservé");
    expect(w.file(".env")).toMatch(/^GITHUB_APP_ID=123456$/m);
    expect(w.file(".env")).toMatch(/^JULES_DOMAIN=jules\.example\.org$/m);
    expect(second.calls.at(-1)).toBe("docker compose --profile tunnel up -d --wait");
  });

  it("refuse un hôte sans gVisor, un Docker trop ancien ou une valeur douteuse", () => {
    const w = workspace();
    const noGvisor = w.run("install.sh", [], { FAKE_RUNTIMES: "io.containerd.runc.v2 runc" });
    expect(noGvisor.status).toBe(1);
    expect(noGvisor.stderr).toContain("gVisor (runsc)");
    expect(noGvisor.calls).not.toContain("docker compose build");

    const trial = w.run("install.sh", ["--allow-runc", "--no-start"], {
      FAKE_RUNTIMES: "io.containerd.runc.v2 runc",
    });
    expect(trial.status, trial.stderr).toBe(0);
    expect(w.file(".env")).toMatch(/^JULES_SANDBOX_RUNTIME=runc$/m);
    expect(trial.calls.some((c) => c.includes(" up "))).toBe(false);

    const old = w.run("install.sh", [], { FAKE_DOCKER_VERSION: "27.5.1" });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("Docker 28 ou plus récent");

    for (const args of [
      ["--domain", "x|touch /tmp/pwned"],
      ["--admins", "a;b"],
      ["--expose", "ngrok"],
    ]) {
      const refused = w.run("install.sh", args);
      expect(refused.status, args.join(" ")).toBe(1);
      expect(refused.calls).toEqual([]);
    }
  });
});

describe("montée de version (M11)", () => {
  it("sauvegarde, code du tag, images, migrations moteur arrêté, redémarrage, vérifications", () => {
    const w = workspace();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", w.root, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
        .toString()
        .trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "v1.0.0");
    git("tag", "v1.0.0");
    writeFileSync(join(w.root, "NOUVEAU"), "1.0.1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "v1.0.1");
    git("tag", "v1.0.1");
    git("checkout", "-q", "v1.0.0");

    const done = w.run("upgrade.sh", ["v1.0.1"]);
    expect(done.status, done.stderr).toBe(0);
    expect(git("describe", "--tags")).toBe("v1.0.1");
    expect(done.calls).toEqual([
      "docker compose --profile ops run --rm backup",
      "docker compose build",
      "docker compose --profile images build",
      "docker compose stop worker api gateway",
      "docker compose run --rm migrate",
      "docker compose up -d --wait",
      "docker compose run --rm worker node dist/cli.js audit verify",
      "docker compose run --rm worker node dist/cli.js secrets verify",
    ]);
  });

  it("sans sauvegarde, rien ne change ; une migration en échec ne redémarre rien", () => {
    const w = workspace();
    const noBackup = w.run("upgrade.sh", [], { FAKE_BACKUP_EXIT: "1" });
    expect(noBackup.status).toBe(1);
    expect(noBackup.stderr).toContain("montée de version annulée");
    expect(noBackup.calls).toEqual(["docker compose --profile ops run --rm backup"]);

    const failed = w.run("upgrade.sh", [], { FAKE_MIGRATE_EXIT: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("migration en échec");
    expect(failed.calls.some((c) => c.includes(" up "))).toBe(false);

    expect(w.run("upgrade.sh", ["main; rm -rf /"]).status).toBe(1);
  });
});
