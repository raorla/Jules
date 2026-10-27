import { randomBytes } from "node:crypto";
import { appendAudit } from "@jules/audit";
import { DEFAULT_ORG_ID, and, eq, memberships, sql, users, type Db } from "@jules/db";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, createSession } from "./session.js";

// Connexion GitHub OAuth (ARCHITECTURE.md §4.2). Seules les personnes membres de l'organisation Jules
// (ou listées comme admins au démarrage) peuvent se connecter ; l'audit ne garde que leur identifiant.

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** https://github.com en production ; un faux serveur dans les tests. */
  webBase: string;
  apiBase: string;
};

const STATE_COOKIE = "jules_oauth_state";

export function registerOAuth(
  app: FastifyInstance,
  options: {
    db: Db;
    oauth: OAuthConfig;
    publicUrl: string;
    adminLogins: readonly string[];
    ttlHours: number;
    secureCookies: boolean;
  },
) {
  const { db, oauth } = options;
  const redirectUri = `${options.publicUrl}/v1/auth/github/callback`;
  const cookieBase = {
    path: "/",
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: "strict" as const,
  };

  app.get("/v1/auth/github", async (_request, reply) => {
    const state = randomBytes(24).toString("base64url");
    // SameSite=Lax pour l'état : le retour de GitHub est une navigation venue d'un autre site.
    void reply.setCookie(STATE_COOKIE, state, { ...cookieBase, sameSite: "lax", maxAge: 600 });
    const url = new URL("/login/oauth/authorize", oauth.webBase);
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "read:user");
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/v1/auth/github/callback",
    async (request, reply) => {
      const { code, state } = request.query;
      const expected = request.cookies[STATE_COOKIE];
      void reply.clearCookie(STATE_COOKIE, { path: "/" });
      if (!code || !state || !expected || state !== expected) {
        return reply.code(400).send({ error: "état OAuth invalide" });
      }
      const tokenResponse = await fetch(new URL("/login/oauth/access_token", oauth.webBase), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const { access_token: accessToken } = (await tokenResponse.json()) as {
        access_token?: string;
      };
      if (!accessToken) {
        return reply.code(401).send({ error: "GitHub a refusé la connexion" });
      }
      const profile = (await (
        await fetch(new URL("/user", oauth.apiBase), {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        })
      ).json()) as {
        id?: number;
        login?: string;
      };
      if (!profile.id || !profile.login) {
        return reply.code(401).send({ error: "profil GitHub illisible" });
      }
      // Le jeton OAuth ne sert qu'à identifier la personne : il n'est ni stocké ni réutilisé.
      const login = profile.login;
      const githubId = profile.id;
      const userId = await db.transaction(async (tx) => {
        const [byId] = await tx
          .select()
          .from(users)
          .where(and(eq(users.orgId, DEFAULT_ORG_ID), eq(users.githubUserId, githubId)));
        const [byLogin] = byId
          ? [byId]
          : await tx
              .select()
              .from(users)
              .where(
                and(
                  eq(users.orgId, DEFAULT_ORG_ID),
                  eq(users.login, login),
                  sql`${users.githubUserId} is null`,
                ),
              );
        const user =
          byLogin ??
          (
            await tx
              .insert(users)
              .values({ orgId: DEFAULT_ORG_ID, githubUserId: githubId, login, kind: "human" })
              .returning()
          )[0];
        if (!user) {
          throw new Error("utilisateur non créé");
        }
        await tx
          .update(users)
          .set({ githubUserId: githubId, login, updatedAt: sql`now()` })
          .where(eq(users.id, user.id));
        const [membership] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.orgId, DEFAULT_ORG_ID), eq(memberships.userId, user.id)));
        if (!membership && options.adminLogins.includes(login)) {
          await tx
            .insert(memberships)
            .values({ orgId: DEFAULT_ORG_ID, userId: user.id, role: "admin" });
          return user.id;
        }
        return membership ? user.id : undefined;
      });
      if (!userId) {
        return reply
          .code(403)
          .type("text/html")
          .send(
            "<!doctype html><meta charset=utf-8><p>Ce compte GitHub n'est pas membre de cette instance de Jules. Demande un accès à un admin.</p>",
          );
      }
      const { token } = await createSession(db, {
        orgId: DEFAULT_ORG_ID,
        userId,
        kind: "web",
        ttlHours: options.ttlHours,
      });
      await appendAudit(db, {
        orgId: DEFAULT_ORG_ID,
        actor: { type: "user", id: userId },
        action: "session.created",
        target: { type: "user", id: userId },
        data: { via: "github_oauth" },
      });
      void reply.setCookie(SESSION_COOKIE, token, {
        ...cookieBase,
        maxAge: options.ttlHours * 3600,
      });
      return reply.redirect("/");
    },
  );
}
