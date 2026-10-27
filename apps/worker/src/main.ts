import { DEFAULT_ORG_ID, createDatabase } from "@jules/db";
import { OctokitGitHubApp } from "@jules/forge";
import { SecretStore, keyringFromEnv } from "@jules/secrets";
import { GITHUB_APP_KEY_SECRET, loadWorkerEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { Worker } from "./worker.js";

const env = loadWorkerEnv();
const log = createLogger(env.LOG_LEVEL);
const database = createDatabase(env.DATABASE_URL);

const privateKey = await new SecretStore(database.db, keyringFromEnv(env)).get(
  DEFAULT_ORG_ID,
  GITHUB_APP_KEY_SECRET,
);
if (!privateKey) {
  log.fatal(
    `secret ${GITHUB_APP_KEY_SECRET} absent : lancer \`jules secrets set ${GITHUB_APP_KEY_SECRET} < clé.pem\``,
  );
  process.exit(1);
}

const worker = new Worker(
  {
    db: database.db,
    github: new OctokitGitHubApp({
      appId: env.GITHUB_APP_ID,
      privateKey: privateKey.toString("utf8"),
    }),
    log,
    settings: { mention: env.JULES_MENTION, label: env.JULES_LABEL, language: env.JULES_LANGUAGE },
  },
  { databaseUrl: env.DATABASE_URL },
);
privateKey.fill(0);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "arrêt du worker");
    void worker.stop().then(() => database.close());
  });
}

await worker.start();
log.info("worker démarré");
