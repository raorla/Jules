import { languageSchema, loadEnv } from "@jules/config";
import { z } from "zod";

export const GITHUB_APP_KEY_SECRET = "github_app_private_key";
export const ANTHROPIC_KEY_SECRET = "anthropic_api_key";

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

export const loadWorkerEnv = () =>
  loadEnv(
    z.object({
      ...base,
      JULES_MASTER_KEY: z.string().min(1),
      JULES_MASTER_KEY_PREVIOUS: z.string().optional(),
      GITHUB_APP_ID: z.coerce.number().int().positive(),
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
      JULES_DEVELOPER_MODEL: z.string().default("claude-opus-5-5"),
      JULES_DEVELOPER_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("xhigh"),
      JULES_DEVELOPER_FALLBACK_MODEL: z.string().default("claude-sonnet-5-5"),
      JULES_DEVELOPER_BUDGET_USD: z.coerce.number().positive().default(15),
      JULES_DEVELOPER_MAX_TURNS: z.coerce.number().int().positive().default(150),
      JULES_DEVELOPER_TIMEOUT_MIN: z.coerce.number().positive().default(45),
      // Budget d'une tâche, toutes phases comprises ; `/jules budget +n` peut le monter jusqu'au plafond.
      JULES_TASK_BUDGET_USD: z.coerce.number().positive().default(30),
      JULES_TASK_BUDGET_CAP_USD: z.coerce.number().positive().default(100),
    }),
  );
export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;
