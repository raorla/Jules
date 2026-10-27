#!/usr/bin/env node
import { verifyAuditChain } from "@jules/audit";
import { DEFAULT_ORG_ID, createDatabase, migrate, orgs, secrets } from "@jules/db";
import { OctokitGitHubApp } from "@jules/forge";
import { SandboxDriver } from "@jules/sandbox";
import { SecretStore, generateMasterKey, keyringFromEnv, parseMasterKey } from "@jules/secrets";
import { parseArgs } from "node:util";
import { GITHUB_APP_KEY_SECRET, loadBaseEnv, loadSecretsEnv, loadWorkerEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { liftStop, stopAll } from "./emergency.js";
import { reconcileDeliveries } from "./reconcile.js";

// Commandes d'exploitation du serveur (`jules …`). Elles marchent sans l'api.

const USAGE = `usage : jules <commande>

  migrate                      applique les migrations de la base
  master-key generate          crée une clé maître (à copier aussi hors de la machine)
  master-key fingerprint       affiche l'empreinte de JULES_MASTER_KEY
  secrets set <nom>            chiffre et enregistre la valeur lue sur l'entrée standard
  secrets verify               déchiffre chaque secret sans l'afficher (test de restauration)
  secrets rotate               rechiffre les secrets avec JULES_MASTER_KEY
                               (l'ancienne clé dans JULES_MASTER_KEY_PREVIOUS)
  audit verify                 vérifie la chaîne du journal d'audit de chaque organisation
  reconcile [--hours <n>]      redemande à GitHub les webhooks manqués (72 h maximum)
  stop --all [--reason <r>]    arrêt d'urgence : bloque tout, révoque les jetons, tue les sandboxes
  stop --lift                  lève l'arrêt d'urgence
`;

async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) {
    throw new Error(
      "passe la valeur par l'entrée standard, par exemple : jules secrets set nom < fichier",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function withDatabase<T>(
  url: string,
  fn: (db: ReturnType<typeof createDatabase>) => Promise<T>,
) {
  const database = createDatabase(url, { max: 2 });
  try {
    return await fn(database);
  } finally {
    await database.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      hours: { type: "string" },
      help: { type: "boolean", short: "h" },
      all: { type: "boolean" },
      lift: { type: "boolean" },
      reason: { type: "string" },
    },
  });
  const [command, sub, arg] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  if (command === "migrate") {
    const env = loadBaseEnv();
    await withDatabase(env.DATABASE_URL, ({ db }) => migrate(db));
    process.stdout.write("migrations appliquées\n");
    return 0;
  }

  if (command === "master-key" && sub === "generate") {
    const key = generateMasterKey();
    process.stdout.write(
      `${key}\nempreinte : ${parseMasterKey(key).id}\n` +
        "Range une copie de cette clé hors de la machine (gestionnaire de mots de passe ou papier).\n" +
        "Sans elle, les secrets d'une sauvegarde sont perdus.\n",
    );
    return 0;
  }

  if (command === "master-key" && sub === "fingerprint") {
    const env = loadSecretsEnv();
    process.stdout.write(`${parseMasterKey(env.JULES_MASTER_KEY).id}\n`);
    return 0;
  }

  if (command === "secrets" && sub === "set" && arg) {
    const env = loadSecretsEnv();
    const value = await readStdin();
    await withDatabase(env.DATABASE_URL, ({ db }) =>
      new SecretStore(db, keyringFromEnv(env)).set(DEFAULT_ORG_ID, arg, value),
    );
    value.fill(0);
    process.stdout.write(`secret ${arg} enregistré\n`);
    return 0;
  }

  if (command === "secrets" && sub === "verify") {
    const env = loadSecretsEnv();
    return withDatabase(env.DATABASE_URL, async ({ db }) => {
      const store = new SecretStore(db, keyringFromEnv(env));
      let failed = 0;
      const rows = await db.select({ orgId: secrets.orgId, name: secrets.name }).from(secrets);
      for (const row of rows) {
        try {
          (await store.get(row.orgId, row.name))?.fill(0);
        } catch {
          failed += 1;
          process.stdout.write(`indéchiffrable : ${row.name}\n`);
        }
      }
      process.stdout.write(`${rows.length - failed}/${rows.length} secret(s) déchiffrable(s)\n`);
      return failed === 0 ? 0 : 2;
    });
  }

  if (command === "secrets" && sub === "rotate") {
    const env = loadSecretsEnv();
    const count = await withDatabase(env.DATABASE_URL, ({ db }) =>
      new SecretStore(db, keyringFromEnv(env)).rotateMasterKey(),
    );
    process.stdout.write(
      `${count} secret(s) rechiffré(s) avec la clé ${parseMasterKey(env.JULES_MASTER_KEY).id}\n`,
    );
    return 0;
  }

  if (command === "audit" && sub === "verify") {
    const env = loadBaseEnv();
    return withDatabase(env.DATABASE_URL, async ({ db }) => {
      let ok = true;
      for (const org of await db.select({ id: orgs.id, slug: orgs.slug }).from(orgs)) {
        const result = await verifyAuditChain(db, org.id);
        if (result.ok) {
          process.stdout.write(
            `${org.slug} : ${result.checked} ligne(s), tête ${result.headHash}\n`,
          );
        } else {
          ok = false;
          process.stdout.write(
            `${org.slug} : CHAÎNE ROMPUE à la ligne ${result.seq} (${result.reason})\n`,
          );
        }
      }
      return ok ? 0 : 2;
    });
  }

  if (command === "stop" && (values.all || values.lift)) {
    const env = loadBaseEnv();
    return withDatabase(env.DATABASE_URL, async ({ db }) => {
      if (values.lift) {
        const lifted = await liftStop(db, { orgId: DEFAULT_ORG_ID, actorId: "cli" });
        process.stdout.write(`${lifted} arrêt(s) levé(s)\n`);
        return 0;
      }
      const started = Date.now();
      const report = await stopAll(db, new SandboxDriver({ runtime: "runsc", egressImage: "-" }), {
        orgId: DEFAULT_ORG_ID,
        reason: values.reason ?? "jules stop --all",
        actorId: "cli",
      });
      process.stdout.write(
        `arrêt d'urgence actif : ${report.killedContainers} conteneur(s) tué(s), ${report.revokedTokens} jeton(s) révoqué(s) en ${Date.now() - started} ms\n` +
          "Rien ne redémarre tant que l'arrêt n'est pas levé (jules stop --lift).\n",
      );
      return 0;
    });
  }

  if (command === "reconcile") {
    const env = loadWorkerEnv();
    const hours = values.hours ? Number(values.hours) : 72;
    return withDatabase(env.DATABASE_URL, async ({ db }) => {
      const key = await new SecretStore(db, keyringFromEnv(env)).get(
        DEFAULT_ORG_ID,
        GITHUB_APP_KEY_SECRET,
      );
      if (!key) {
        throw new Error(`secret ${GITHUB_APP_KEY_SECRET} absent`);
      }
      const report = await reconcileDeliveries(
        {
          db,
          github: new OctokitGitHubApp({
            appId: env.GITHUB_APP_ID,
            privateKey: key.toString("utf8"),
          }),
          log: createLogger(env.LOG_LEVEL),
          settings: {
            mention: env.JULES_MENTION,
            label: env.JULES_LABEL,
            language: env.JULES_LANGUAGE,
          },
        },
        { lookbackMs: hours * 3600_000 },
      );
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    });
  }

  process.stderr.write(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`erreur : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
