import { fileURLToPath } from "node:url";
import { loadEnv } from "@jules/config";
import { createDatabase } from "@jules/db";
import { z } from "zod";
import { buildApi } from "./app.js";

const env = loadEnv(
  z.object({
    DATABASE_URL: z.string().min(1),
    JULES_PUBLIC_URL: z.url(),
    GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
    JULES_ADMIN_LOGINS: z.string().default(""),
    JULES_WEB_DIR: z.string().optional(),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().default(3001),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
);

const database = createDatabase(env.DATABASE_URL, { max: 10 });
const app = await buildApi({
  db: database.db,
  pool: database.pool,
  publicUrl: env.JULES_PUBLIC_URL,
  oauth: {
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    webBase: "https://github.com",
    apiBase: "https://api.github.com",
  },
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
