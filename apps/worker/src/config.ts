import { ConfigError, languageSchema, loadEnv } from "@jules/config";
import { z } from "zod";

export const GITHUB_APP_KEY_SECRET = "github_app_private_key";
export const ANTHROPIC_KEY_SECRET = "anthropic_api_key";
/** Jeton d'un abonnement Claude (`claude setup-token`) : pour une instance personnelle seulement. */
export const CLAUDE_SUBSCRIPTION_SECRET = "claude_oauth_token";

const base = {
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
};

export const loadBaseEnv = () => loadEnv(z.object(base));

export const loadSecretsEnv = () =>
  loadEnv(
    z.object({
      ...base,
      JULES_MASTER_KEY: z.string().min(1),
      JULES_MASTER_KEY_PREVIOUS: z.string().optional(),
    }),
  );

/** Réglages communs au worker GitHub et au worker du mode local. */
const workerShape = {
  ...base,
  JULES_MENTION: z
    .string()
    .regex(/^@[\w-]+$/)
    .default("@jules"),
  JULES_LABEL: z.string().min(1).default("jules"),
  JULES_LANGUAGE: languageSchema.default("fr"),
  // Sandbox (ARCHITECTURE.md §8). `runc` n'est acceptable qu'en développement.
  JULES_RUNS_DIR: z.string().default("/var/lib/jules/runs"),
  JULES_INSTANCE: z
    .string()
    .regex(/^[\w.-]+$/)
    .default("default"),
  JULES_PROMPTS_DIR: z.string().optional(),
  JULES_SANDBOX_RUNTIME: z.string().default("runsc"),
  JULES_SANDBOX_IMAGE: z.string().default("jules-sandbox-node:local"),
  JULES_EGRESS_IMAGE: z.string().default("jules-egress:local"),
  JULES_EGRESS_ALLOW: z.string().default("registry.npmjs.org"),
  JULES_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  // Modèle (ARCHITECTURE.md §6) : l'effort se règle explicitement, Opus 5.5 est à `medium` par défaut.
  JULES_MODEL_UPSTREAM: z.url().default("https://api.anthropic.com"),
  // Accès au modèle sur un serveur : clé API (`anthropic_api_key`), ou abonnement Claude d'une seule
  // personne (`claude_oauth_token`). En mode local, le desktop remet l'un ou l'autre.
  JULES_MODEL_AUTH: z.enum(["api_key", "subscription"]).default("api_key"),
  JULES_DEVELOPER_MODEL: z.string().default("claude-opus-5-5"),
  JULES_DEVELOPER_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("xhigh"),
  JULES_DEVELOPER_FALLBACK_MODEL: z.string().default("claude-sonnet-5-5"),
  JULES_DEVELOPER_BUDGET_USD: z.coerce.number().positive().default(15),
  JULES_DEVELOPER_MAX_TURNS: z.coerce.number().int().positive().default(150),
  JULES_DEVELOPER_TIMEOUT_MIN: z.coerce.number().positive().default(45),
  // Budget d'une tâche, toutes phases comprises ; `/jules budget +n` peut le monter jusqu'au plafond.
  JULES_TASK_BUDGET_USD: z.coerce.number().positive().default(30),
  JULES_TASK_BUDGET_CAP_USD: z.coerce.number().positive().default(100),
};

export const loadWorkerEnv = () =>
  loadEnv(
    z.object({
      ...workerShape,
      JULES_MASTER_KEY: z.string().min(1),
      JULES_MASTER_KEY_PREVIOUS: z.string().optional(),
      GITHUB_APP_ID: z.coerce.number().int().positive(),
    }),
  );

/**
 * Mode local (M10) : ni GitHub App, ni clé maître dans l'environnement. Le desktop remet la clé au
 * démarrage (local/handoff.ts) ; `JULES_MASTER_KEY` reste possible pour le développement.
 */
export const loadLocalWorkerEnv = () => {
  const env = loadEnv(
    z.object({
      ...workerShape,
      JULES_FORGE: z.literal("local"),
      JULES_MASTER_KEY: z.string().min(1).optional(),
      JULES_SECRETS_HANDOFF_URL: z.string().min(1).optional(),
      JULES_SECRETS_HANDOFF_TOKEN: z.string().min(32).optional(),
    }),
  );
  if (
    !env.JULES_MASTER_KEY &&
    !(env.JULES_SECRETS_HANDOFF_URL && env.JULES_SECRETS_HANDOFF_TOKEN)
  ) {
    throw new ConfigError(
      "mode local : JULES_SECRETS_HANDOFF_URL et JULES_SECRETS_HANDOFF_TOKEN sont requis (ou JULES_MASTER_KEY en développement)",
    );
  }
  return env;
};
export type LocalWorkerEnv = ReturnType<typeof loadLocalWorkerEnv>;
export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;
