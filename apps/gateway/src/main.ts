import { loadEnv } from "@jules/config";
import { createDatabase } from "@jules/db";
import { z } from "zod";
import { buildGateway } from "./app.js";

const env = loadEnv(
  z.object({
    DATABASE_URL: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(20, "au moins 20 caractères"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
);

const database = createDatabase(env.DATABASE_URL, { max: 5 });
const app = buildGateway({
  db: database.db,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  logger: { level: env.LOG_LEVEL },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => database.close());
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
