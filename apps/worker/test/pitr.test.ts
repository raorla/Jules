import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ROOT } from "./sandbox-harness.js";

// DoD M11 (ROADMAP.md) : une restauration depuis une sauvegarde est testée, ici à un instant donné.
// Les vrais scripts de deploy/backup, la vraie image, la vraie config PostgreSQL de deploy/compose.yaml
// et un vrai dépôt restic : sauvegarde de base, WAL archivés puis envoyés, restauration à l'instant
// choisi dans un volume neuf, et PostgreSQL qui rejoue les WAL jusque-là, pas au-delà.

const id = crypto.randomUUID().slice(0, 8);
const net = `jules-pitr-${id}`;
const volumes = {
  data: `jules-pitr-data-${id}`,
  repo: `jules-pitr-repo-${id}`,
  restore: `jules-pitr-restore-${id}`,
};
const containers = [`jules-pitr-pg-${id}`, `jules-pitr-restored-${id}`];
const IMAGE = "jules-backup:test";
let secrets: string;

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

const psql = (container: string, query: string) =>
  docker(
    "exec",
    container,
    "psql",
    "-U",
    "jules",
    "-d",
    "jules",
    "-tA",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  );

async function until<T>(check: () => T | undefined, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = check();
      if (value !== undefined) {
        return value;
      }
    } catch {
      // Pas encore prêt.
    }
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé : ${what}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Prêt en TCP : pendant l'initialisation, le serveur temporaire n'écoute que sur le socket local. */
const ready = (container: string) =>
  until(
    () =>
      spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "jules"])
        .status === 0
        ? true
        : undefined,
    `${container} prêt`,
  );

/** Un script de deploy/backup dans l'image, comme `docker compose --profile ops run backup`. */
const backup = (entrypoint: string, mounts: string[], ...args: string[]) =>
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      net,
      "-v",
      `${secrets}:/run/secrets:ro`,
      "-v",
      `${volumes.repo}:/repo`,
      ...mounts.flatMap((m) => ["-v", m]),
      "-e",
      "PGHOST=postgres",
      "-e",
      "PGUSER=jules",
      "-e",
      "PGDATABASE=jules",
      "-e",
      "PGPASSFILE=/tmp/pgpass",
      "-e",
      "RESTIC_REPOSITORY=/repo",
      "-e",
      "RESTIC_PASSWORD_FILE=/run/secrets/restic_password",
      "--entrypoint",
      entrypoint,
      IMAGE,
      ...args,
    ],
    { encoding: "utf8" },
  );

beforeAll(() => {
  if (
    !process.env.JULES_TEST_SKIP_BUILD ||
    spawnSync("docker", ["image", "inspect", IMAGE]).status !== 0
  ) {
    docker("build", "-q", "-t", IMAGE, join(ROOT, "deploy", "backup"));
  }
  secrets = mkdtempSync(join(tmpdir(), "jules-pitr-secrets-"));
  writeFileSync(join(secrets, "postgres_password"), crypto.randomUUID());
  writeFileSync(join(secrets, "restic_password"), crypto.randomUUID());
  chmodSync(secrets, 0o755);
  for (const f of ["postgres_password", "restic_password"]) chmodSync(join(secrets, f), 0o644);
  docker("network", "create", net);
  for (const v of Object.values(volumes)) docker("volume", "create", v);
}, 600_000);

afterAll(() => {
  spawnSync("docker", ["rm", "-f", ...containers]);
  spawnSync("docker", ["volume", "rm", ...Object.values(volumes)]);
  spawnSync("docker", ["network", "rm", net]);
});

describe("sauvegarde continue (M11)", () => {
  it("restaure la base à un instant donné, ni avant, ni après", async () => {
    // PostgreSQL avec exactement la commande et l'accès de deploy/compose.yaml.
    const compose = parse(readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8")) as {
      services: { postgres: { image: string; command: string[] } };
    };
    const { image, command } = compose.services.postgres;
    docker(
      "run",
      "-d",
      "--name",
      containers[0]!,
      "--network",
      net,
      "--network-alias",
      "postgres",
      "-e",
      "POSTGRES_DB=jules",
      "-e",
      "POSTGRES_USER=jules",
      "-e",
      "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password",
      "-v",
      `${secrets}:/run/secrets:ro`,
      "-v",
      `${volumes.data}:/var/lib/postgresql`,
      "-v",
      `${join(ROOT, "deploy", "postgres", "pg_hba.conf")}:/etc/postgresql/pg_hba.conf:ro`,
      image,
      ...command,
    );
    await ready(containers[0]!);
    psql(containers[0]!, "create table taches (etat text); insert into taches values ('avant')");

    // Sauvegarde de base (la copie quotidienne), par une connexion `replication` du réseau interne.
    const base = backup("base-backup.sh", [`${volumes.data}:/var/lib/postgresql`]);
    expect(base.status, base.stderr).toBe(0);

    // Après la sauvegarde : une écriture à garder, l'instant cible, puis une écriture à perdre.
    psql(containers[0]!, "insert into taches values ('cible')");
    const target = psql(
      containers[0]!,
      "select to_char(date_trunc('second', clock_timestamp() at time zone 'UTC') + interval '1 second', 'YYYY-MM-DD HH24:MI:SS')",
    );
    await until(
      () =>
        psql(
          containers[0]!,
          `select clock_timestamp() at time zone 'UTC' > '${target}'::timestamp + interval '1 second'`,
        ) === "t"
          ? true
          : undefined,
      "instant cible dépassé",
    );
    psql(containers[0]!, "insert into taches values ('apres')");
    const segment = psql(containers[0]!, "select pg_walfile_name(pg_switch_wal())");
    await until(
      () =>
        psql(containers[0]!, "select coalesce(last_archived_wal, '') from pg_stat_archiver") >=
        segment
          ? true
          : undefined,
      "WAL archivé",
    );
    const pushed = backup("wal-push.sh", [`${volumes.data}:/var/lib/postgresql`]);
    expect(pushed.status, pushed.stderr).toBe(0);

    // Sinistre : un volume neuf, restauré depuis le seul dépôt restic.
    const restored = backup("restore-pitr.sh", [`${volumes.restore}:/var/lib/postgresql`], target);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain(`pour revenir à ${target}`);
    docker(
      "run",
      "-d",
      "--name",
      containers[1]!,
      "--network",
      net,
      "-e",
      "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password",
      "-v",
      `${secrets}:/run/secrets:ro`,
      "-v",
      `${volumes.restore}:/var/lib/postgresql`,
      image,
    );
    await ready(containers[1]!);
    await until(
      () => (psql(containers[1]!, "select pg_is_in_recovery()") === "f" ? true : undefined),
      "récupération terminée",
    );
    expect(psql(containers[1]!, "select string_agg(etat, ',' order by etat) from taches")).toBe(
      "avant,cible",
    );

    // Un volume qui contient déjà une base n'est jamais écrasé ; un instant mal formé est refusé.
    const again = backup("restore-pitr.sh", [`${volumes.restore}:/var/lib/postgresql`], target);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("contient déjà une base");
    const malformed = backup("restore-pitr.sh", [], "hier soir");
    expect(malformed.status).toBe(2);
  }, 600_000);
});
