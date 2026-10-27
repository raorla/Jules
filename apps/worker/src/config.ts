import { languageSchema, loadEnv } from "@jules/config";
import { z } from "zod";

export const GITHUB_APP_KEY_SECRET = "github_app_private_key";

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
    }),
  );
