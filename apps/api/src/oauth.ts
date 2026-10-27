import { createHash, randomBytes } from "node:crypto";
import { appendAudit } from "@jules/audit";
import {
  DEFAULT_ORG_ID,
  and,
  desktopLogins,
  eq,
  memberships,
  sql,
  users,
  type Db,
} from "@jules/db";
import { z } from "zod";
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
const DESKTOP_COOKIE = "jules_desktop_login";
const DESKTOP_CODE_SECONDS = 120;
const DESKTOP_SESSION_HOURS = 24 * 30;

/** Redirection du desktop : une adresse de bouclage seulement (RFC 8252 §7.3), jamais un site. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
      url.port !== "" &&
      url.pathname === "/callback" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

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

  app.get<{
    Querystring: { client?: string; challenge?: string; redirect?: string; state?: string };
  }>("/v1/auth/github", async (request, reply) => {
    const state = randomBytes(24).toString("base64url");
    // Connexion du desktop : PKCE (S256) et retour sur l'adresse de bouclage de l'app.
    if (request.query.client === "desktop") {
      const { challenge = "", redirect = "", state: clientState = "" } = request.query;
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        !isLoopbackRedirect(redirect) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(clientState)
      ) {
        return reply.code(400).send({
          error: "connexion du desktop invalide : PKCE S256 et adresse de bouclage requis",
        });
      }
      const [login] = await db
        .insert(desktopLogins)
        .values({
          orgId: DEFAULT_ORG_ID,
          challenge,
          redirectUri: redirect,
          clientState,
          expiresAt: new Date(Date.now() + 600_000),
        })
        .returning({ id: desktopLogins.id });
      void reply.setCookie(DESKTOP_COOKIE, login?.id ?? "", {
        ...cookieBase,
        sameSite: "lax",
        maxAge: 600,
      });
    }
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
      const desktopLoginId = request.cookies[DESKTOP_COOKIE];
      if (desktopLoginId) {
        void reply.clearCookie(DESKTOP_COOKIE, { path: "/" });
        // Desktop : aucune session dans le navigateur ; un code à usage unique part vers l'app.
        const code = randomBytes(32).toString("base64url");
        const [login] = await db
          .update(desktopLogins)
          .set({
            codeHash: sha256(code),
            userId,
            expiresAt: new Date(Date.now() + DESKTOP_CODE_SECONDS * 1000),
          })
          .where(
            and(
              eq(desktopLogins.id, desktopLoginId),
              sql`${desktopLogins.codeHash} is null`,
              sql`${desktopLogins.expiresAt} > now()`,
            ),
          )
          .returning();
        if (!login) {
          return reply
            .code(400)
            .send({ error: "connexion du desktop expirée : recommence depuis l'app" });
        }
        const back = new URL(login.redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", login.clientState);
        return reply.redirect(back.toString());
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

  // Échange du code contre une session desktop : le vérificateur PKCE prouve que c'est la même app.
  app.post<{ Body: unknown }>("/v1/auth/desktop/token", async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(20).max(200),
        verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
      })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "code ou vérificateur invalide" });
    }
    const [login] = await db
      .update(desktopLogins)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(desktopLogins.codeHash, sha256(body.data.code)),
          sql`${desktopLogins.usedAt} is null`,
          sql`${desktopLogins.expiresAt} > now()`,
        ),
      )
      .returning();
    // Le code est consommé même si le vérificateur est faux : pas de seconde tentative.
    if (!login?.userId || login.challenge !== sha256(body.data.verifier)) {
      return reply
        .code(401)
        .send({ error: "code inconnu, expiré, déjà utilisé, ou vérificateur PKCE faux" });
    }
    const { token } = await createSession(db, {
      orgId: login.orgId,
      userId: login.userId,
      kind: "desktop",
      ttlHours: DESKTOP_SESSION_HOURS,
    });
    const expiresAt = new Date(Date.now() + DESKTOP_SESSION_HOURS * 3600_000).toISOString();
    await appendAudit(db, {
      orgId: login.orgId,
      actor: { type: "user", id: login.userId },
      action: "session.created",
      target: { type: "user", id: login.userId },
      data: { via: "desktop_pkce" },
    });
    return { token, expiresAt };
  });
}
