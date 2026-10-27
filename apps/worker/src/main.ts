import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORG_ID, assertSchemaCurrent, createDatabase } from "@jules/db";
import { OctokitGitHubApp, type GitHubApp } from "@jules/forge";
import { LocalForge } from "@jules/forge/local";
import { SandboxDriver, parseAllowlist } from "@jules/sandbox";
import { SecretStore, keyringFromEnv } from "@jules/secrets";
import { Masker } from "./broker/masking.js";
import { DeploymentService } from "./devops/deployments.js";
import { PlanService } from "./devops/plans.js";
import { ServerService } from "./devops/servers.js";
import { AuditService } from "./security/audits.js";
import { stopAll } from "./emergency.js";
import { ensureWorkerKey } from "./sealed-secrets.js";
import {
  ANTHROPIC_KEY_SECRET,
  GITHUB_APP_KEY_SECRET,
  loadLocalWorkerEnv,
  loadWorkerEnv,
} from "./config.js";
import { receiveHandoff } from "./local/handoff.js";
import { createLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { startTracing } from "./tracing.js";
import { Worker } from "./worker.js";

// Mode local (M10) : même worker, forge locale, clé maître remise par le desktop.
const local = process.env.JULES_FORGE === "local";
const env = local ? loadLocalWorkerEnv() : loadWorkerEnv();
const stopTracing = await startTracing(process.env);
const log = createLogger(env.LOG_LEVEL);
const database = createDatabase(env.DATABASE_URL);
// Le code et la base doivent avoir les mêmes migrations (M11) : ni base en retard, ni base plus récente.
await assertSchemaCurrent(database.db);

// Les seuls secrets d'exécution vivent ici, chiffrés en base et déchiffrés en mémoire (ARCHITECTURE.md §5).
const handoff =
  "JULES_SECRETS_HANDOFF_URL" in env &&
  env.JULES_SECRETS_HANDOFF_URL &&
  env.JULES_SECRETS_HANDOFF_TOKEN
    ? await receiveHandoff(env.JULES_SECRETS_HANDOFF_URL, env.JULES_SECRETS_HANDOFF_TOKEN)
    : undefined;
const store = new SecretStore(database.db, handoff?.keyring ?? keyringFromEnv(env));
const apiKey = handoff?.anthropicApiKey
  ? Buffer.from(handoff.anthropicApiKey)
  : await store.get(DEFAULT_ORG_ID, ANTHROPIC_KEY_SECRET);
if (!apiKey) {
  log.fatal(
    `secret ${ANTHROPIC_KEY_SECRET} absent : lancer \`jules secrets set ${ANTHROPIC_KEY_SECRET} < fichier\``,
  );
  process.exit(1);
}
if (env.JULES_SANDBOX_RUNTIME !== "runsc") {
  log.warn(
    { runtime: env.JULES_SANDBOX_RUNTIME },
    local
      ? "sandbox sans gVisor : isolation par la VM de Docker Desktop ou runc seulement"
      : "sandbox sans gVisor : acceptable en développement seulement",
  );
}

let github: GitHubApp;
if ("GITHUB_APP_ID" in env) {
  const privateKey = await store.get(DEFAULT_ORG_ID, GITHUB_APP_KEY_SECRET);
  if (!privateKey) {
    log.fatal(
      `secret ${GITHUB_APP_KEY_SECRET} absent : lancer \`jules secrets set ${GITHUB_APP_KEY_SECRET} < fichier\``,
    );
    process.exit(1);
  }
  github = new OctokitGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: privateKey.toString("utf8"),
  });
  privateKey.fill(0);
} else {
  const forge = new LocalForge(database.db);
  log.info({ repos: await forge.load() }, "mode local : forge sur les dossiers de la machine");
  github = forge;
}
const anthropicKey = apiKey.toString("utf8").trim();
apiKey.fill(0);
await mkdir(env.JULES_RUNS_DIR, { recursive: true, mode: 0o700 });
// Clé publique des sealed boxes : l'api s'en sert pour les secrets saisis dans l'interface.
await ensureWorkerKey(database.db, store);

const driver = new SandboxDriver({
  runtime: env.JULES_SANDBOX_RUNTIME,
  egressImage: env.JULES_EGRESS_IMAGE,
});
const masker = new Masker([anthropicKey]);
// Agent DevOps (M7) : le worker est le seul à se connecter aux serveurs.
const servers = new ServerService({ db: database.db, secrets: store, masker, log });
const plans: PlanService = new PlanService({
  db: database.db,
  servers,
  log,
  // Le service des déploiements est créé juste après : il n'est appelé qu'à la fin d'un plan.
  onFinished: (tx, plan, outcome) => deployments.onPlanFinished(tx, plan, outcome),
});
const deployments: DeploymentService = new DeploymentService({
  db: database.db,
  github,
  plans,
  servers,
  log,
  runsDir: env.JULES_RUNS_DIR,
});
// Agent Sécurité (M8) : audits exécutés par le worker, findings en base.
const audits = new AuditService({
  db: database.db,
  github,
  servers,
  masker,
  log,
  runsDir: env.JULES_RUNS_DIR,
});
const orchestrator = new Orchestrator({
  db: database.db,
  github,
  driver,
  log,
  masker,
  devops: { servers, plans },
  security: { audits },
  config: {
    runsDir: env.JULES_RUNS_DIR,
    promptsDir:
      env.JULES_PROMPTS_DIR ?? fileURLToPath(new URL("../../../prompts", import.meta.url)),
    sandboxImage: env.JULES_SANDBOX_IMAGE,
    egressAllow: parseAllowlist(env.JULES_EGRESS_ALLOW),
    language: env.JULES_LANGUAGE,
    model: { upstream: env.JULES_MODEL_UPSTREAM, apiKey: anthropicKey },
    developer: {
      model: env.JULES_DEVELOPER_MODEL,
      effort: env.JULES_DEVELOPER_EFFORT,
      fallbackModel: env.JULES_DEVELOPER_FALLBACK_MODEL,
      maxTurns: env.JULES_DEVELOPER_MAX_TURNS,
      budgetUsd: env.JULES_DEVELOPER_BUDGET_USD,
      timeoutMs: env.JULES_DEVELOPER_TIMEOUT_MIN * 60_000,
    },
    taskBudgetUsd: env.JULES_TASK_BUDGET_USD,
    maxConcurrentRuns: env.JULES_MAX_CONCURRENT_RUNS,
    providerRetryBaseMs: 5 * 60_000,
    maxAttempts: 3,
  },
});

const worker = new Worker(
  {
    db: database.db,
    github,
    log,
    settings: { mention: env.JULES_MENTION, label: env.JULES_LABEL, language: env.JULES_LANGUAGE },
    taskBudgetCapUsd: env.JULES_TASK_BUDGET_CAP_USD,
    plans,
    emergency: {
      stopAll: (actorId) =>
        stopAll(database.db, driver, { orgId: DEFAULT_ORG_ID, reason: "/jules stop-all", actorId }),
    },
  },
  {
    databaseUrl: env.DATABASE_URL,
    orchestrator,
    runsDir: env.JULES_RUNS_DIR,
    secrets: store,
    devops: { servers, plans, deployments },
    security: { audits },
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "arrêt du worker");
    void worker
      .stop()
      .then(() => database.close())
      .then(() => stopTracing?.());
  });
}

await worker.start();
log.info("worker démarré");
