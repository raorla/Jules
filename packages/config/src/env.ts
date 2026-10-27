import { readFileSync } from "node:fs";
import { z } from "zod";

// Variables d'environnement des apps. Un secret peut aussi être lu depuis un fichier
// (`NOM_FILE=/run/secrets/nom`), ce qui évite de le mettre dans l'environnement du conteneur.

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function loadEnv<T extends z.ZodObject>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const resolved: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(schema.shape)) {
    const file = env[`${key}_FILE`];
    if (file && resolved[key] === undefined) {
      resolved[key] = readFileSync(file, "utf8").trim();
    }
  }
  const result = schema.safeParse(resolved);
  if (!result.success) {
    throw new ConfigError(`configuration invalide :\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const languageSchema = z.enum(["fr", "en"]);
export type Language = z.infer<typeof languageSchema>;
