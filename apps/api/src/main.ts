import { fileURLToPath } from "node:url";
import { loadEnv } from "@jules/config";
import { assertSchemaCurrent, createDatabase } from "@jules/db";
import { z } from "zod";
import { buildApi } from "./app.js";

const base = {
  DATABASE_URL: z.string().min(1),
  JULES_ADMIN_LOGINS: z.string().default(""),
  JULES_WEB_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
};

// Mode local (M10) : l'api n'écoute que sur l'adresse de bouclage et n'a aucun identifiant GitHub.
const local = process.env.JULES_MODE === "local";
const env = local
  ? loadEnv(
      z.object({
        ...base,
        JULES_PUBLIC_URL: z.url().default("http://127.0.0.1:3001"),
        JULES_LOCAL_LOGIN_HASH: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        JULES_LOCAL_STEPUP_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        JULES_LOCAL_ROOTS: z.string().default(""),
        HOST: z.enum(["127.0.0.1", "::1", "0.0.0.0"]).default("127.0.0.1"),
        PORT: z.coerce.number().int().default(3001),
      }),
    )
  : loadEnv(
      z.object({
        ...base,
        JULES_PUBLIC_URL: z.url(),
        GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
        GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
        HOST: z.string().default("0.0.0.0"),
        PORT: z.coerce.number().int().default(3001),
      }),
    );

const database = createDatabase(env.DATABASE_URL, { max: 10 });
// Le code et la base doivent avoir les mêmes migrations (M11) : ni base en retard, ni base plus récente.
await assertSchemaCurrent(database.db);
const app = await buildApi({
  db: database.db,
  pool: database.pool,
  publicUrl: env.JULES_PUBLIC_URL,
  ...("GITHUB_OAUTH_CLIENT_ID" in env
    ? {
        oauth: {
          clientId: env.GITHUB_OAUTH_CLIENT_ID,
          clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
          webBase: "https://github.com",
          apiBase: "https://api.github.com",
        },
      }
    : {
        local: {
          loginHash: env.JULES_LOCAL_LOGIN_HASH,
          stepUpPublicKey: env.JULES_LOCAL_STEPUP_PUBLIC_KEY,
          roots: env.JULES_LOCAL_ROOTS.split(",")
            .map((r) => r.trim())
            .filter(Boolean),
        },
      }),
  adminLogins: env.JULES_ADMIN_LOGINS.split(",")
    .map((l) => l.trim())
    .filter(Boolean),
  webDir: env.JULES_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  logger: { level: env.LOG_LEVEL },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => database.close());
  });
}
await app.listen({ host: env.HOST, port: env.PORT });
