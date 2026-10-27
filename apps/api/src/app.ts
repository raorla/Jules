import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sql, type Db } from "@jules/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type pg from "pg";
import { registerLocalRoutes, type LocalModeOptions } from "./local-routes.js";
import { registerOAuth, type OAuthConfig } from "./oauth.js";
import { registerPasskeys, type RelyingParty } from "./passkeys.js";
import { registerDevopsRoutes } from "./devops-routes.js";
import { registerRoutes } from "./routes.js";
import { registerSecurityRoutes } from "./security-routes.js";

// api (ARCHITECTURE.md §4.2) : REST `/v1` et SSE pour le web et le desktop, et la SPA servie avec une
// CSP stricte. Aucun secret d'exécution ici : ni clé de la GitHub App, ni clé API, ni clé SSH.

export type ApiOptions = {
  db: Db;
  pool: pg.Pool;
  publicUrl: string;
  /** Connexion GitHub ; absente en mode local. */
  oauth?: OAuthConfig;
  /** Mode local du desktop (M10) : connexion par secret, dossiers git, merge par le bouton. */
  local?: LocalModeOptions;
  adminLogins: readonly string[];
  sessionTtlHours?: number;
  /** Origines supplémentaires de la webview desktop (tests de l'interface desktop dans un navigateur). */
  desktopOrigins?: readonly string[];
  /** Dossier de la SPA construite (apps/web/dist). */
  webDir?: string;
  logger?: FastifyServerOptions["logger"];
};

/** Origines de la webview Tauri selon l'OS (macOS et Linux : tauri://, Windows : http(s)://tauri.localhost). */
export const DESKTOP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

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

  // Desktop (Tauri) : la webview a sa propre origine. Requêtes par jeton porteur seulement, jamais de
  // cookie : autoriser ces origines ne permet aucune requête forgée par un autre site.
  const desktopOrigins = new Set([...DESKTOP_ORIGINS, ...(options.desktopOrigins ?? [])]);
  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin && desktopOrigins.has(origin) && request.url.startsWith("/v1/")) {
      void reply.header("access-control-allow-origin", origin);
      void reply.header("vary", "Origin");
      void reply.header("access-control-allow-headers", "authorization, content-type, accept");
      void reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
      void reply.header("access-control-max-age", "600");
      if (request.method === "OPTIONS") {
        void reply.code(204).send();
        return;
      }
    }
    done();
  });

  app.get("/v1/health", async () => {
    await options.db.execute(sql`select 1`);
    return {
      ok: true,
      api: "v1",
      mode: options.local ? "local" : "server",
      desktop: { minVersion: "0.1.0" },
    };
  });

  if (options.oauth) {
    registerOAuth(app, {
      db: options.db,
      oauth: options.oauth,
      publicUrl: publicOrigin,
      adminLogins: options.adminLogins,
      ttlHours: options.sessionTtlHours ?? 12,
      secureCookies: url.protocol === "https:",
    });
  }
  if (options.local) {
    registerLocalRoutes(app, { db: options.db, publicOrigin, local: options.local });
  }
  registerPasskeys(app, { db: options.db, rp });
  registerRoutes(app, { db: options.db, publicOrigin, pool: options.pool });
  registerDevopsRoutes(app, { db: options.db, publicOrigin });
  registerSecurityRoutes(app, { db: options.db, publicOrigin });

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
