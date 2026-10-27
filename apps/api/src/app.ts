import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sql, type Db } from "@jules/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type pg from "pg";
import { registerOAuth, type OAuthConfig } from "./oauth.js";
import { registerPasskeys, type RelyingParty } from "./passkeys.js";
import { registerDevopsRoutes } from "./devops-routes.js";
import { registerRoutes } from "./routes.js";

// api (ARCHITECTURE.md §4.2) : REST `/v1` et SSE pour le web et le desktop, et la SPA servie avec une
// CSP stricte. Aucun secret d'exécution ici : ni clé de la GitHub App, ni clé API, ni clé SSH.

export type ApiOptions = {
  db: Db;
  pool: pg.Pool;
  publicUrl: string;
  oauth: OAuthConfig;
  adminLogins: readonly string[];
  sessionTtlHours?: number;
  /** Dossier de la SPA construite (apps/web/dist). */
  webDir?: string;
  logger?: FastifyServerOptions["logger"];
};

/** CSP stricte : aucun script en ligne, aucun domaine tiers. Le contenu des agents ne peut rien exécuter. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
].join("; ");

export async function buildApi(options: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  const url = new URL(options.publicUrl);
  const publicOrigin = url.origin;
  const rp: RelyingParty = { id: url.hostname, name: "Jules", origin: publicOrigin };
  await app.register(cookie);

  app.addHook("onSend", (_request, reply, payload, done) => {
    void reply.header("content-security-policy", CSP);
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("referrer-policy", "same-origin");
    void reply.header("x-frame-options", "DENY");
    void reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    done(null, payload);
  });

  app.get("/v1/health", async () => {
    await options.db.execute(sql`select 1`);
    return { ok: true, api: "v1", desktop: { minVersion: "0.1.0" } };
  });

  registerOAuth(app, {
    db: options.db,
    oauth: options.oauth,
    publicUrl: publicOrigin,
    adminLogins: options.adminLogins,
    ttlHours: options.sessionTtlHours ?? 12,
    secureCookies: url.protocol === "https:",
  });
  registerPasskeys(app, { db: options.db, rp });
  registerRoutes(app, { db: options.db, publicOrigin, pool: options.pool });
  registerDevopsRoutes(app, { db: options.db, publicOrigin });

  if (options.webDir && existsSync(join(options.webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webDir, wildcard: false });
    // SPA : toute route hors `/v1` renvoie l'application, qui gère son propre routage.
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/v1/")
        ? reply.code(404).send({ error: "introuvable" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
