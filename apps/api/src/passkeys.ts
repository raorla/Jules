import { randomBytes } from "node:crypto";
import { appendAudit } from "@jules/audit";
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  passkeys,
  sessions,
  sql,
  webauthnChallenges,
  type Db,
} from "@jules/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyInstance } from "fastify";
import { grantStepUp, guard, sessionOf } from "./session.js";

// Passkeys (WebAuthn, ARCHITECTURE.md §4.2) : une action sensible exige une passkey au moment même
// de l'action, même avec une session ouverte. Une session volée ne suffit donc pas. La webview du
// desktop n'a pas de passkey, et son origine n'est pas celle du serveur : le desktop connecté fait la
// sienne dans le navigateur du système (`/v1/step-up/browser`), sur cette page du serveur.

export type RelyingParty = { id: string; name: string; origin: string };

type ChallengeKind = "register" | "step_up" | "browser" | "keychain";

const CHALLENGE_MINUTES = 5;

export async function saveChallenge(
  db: Db,
  session: { id: string; orgId: string },
  kind: ChallengeKind,
  challenge: string,
  purpose: string,
) {
  await db.insert(webauthnChallenges).values({
    orgId: session.orgId,
    sessionId: session.id,
    kind,
    challenge,
    purpose,
    expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000),
  });
}

/** Le défi est à usage unique : lu puis supprimé. */
export async function takeChallenge(db: Db, sessionId: string, kind: ChallengeKind) {
  const [row] = await db
    .select()
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.sessionId, sessionId),
        eq(webauthnChallenges.kind, kind),
        gt(webauthnChallenges.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(webauthnChallenges.createdAt))
    .limit(1);
  await db
    .delete(webauthnChallenges)
    .where(and(eq(webauthnChallenges.sessionId, sessionId), eq(webauthnChallenges.kind, kind)));
  return row;
}

/** Identifiant de demande ou défi : 32 octets aléatoires, en base64url. */
export const randomChallenge = () => randomBytes(32).toString("base64url");

const purposeOf = (value: unknown) =>
  (typeof value === "string" && value.trim() ? value.trim() : "action sensible").slice(0, 100);

export function registerPasskeys(app: FastifyInstance, options: { db: Db; rp: RelyingParty }) {
  const { db, rp } = options;
  const auth = (role: "viewer") => guard({ db, publicOrigin: rp.origin }, role);

  /** Options d'une passkey de la personne, avec un défi enregistré pour la session à renforcer. */
  const authenticationOptions = async (
    session: { id: string; orgId: string; userId: string },
    purpose: string,
  ) => {
    const keys = await db.select().from(passkeys).where(eq(passkeys.userId, session.userId));
    if (keys.length === 0) {
      return undefined;
    }
    const opts = await generateAuthenticationOptions({
      rpID: rp.id,
      allowCredentials: keys.map((k) => ({
        id: k.credentialId,
        transports: (k.transports as AuthenticatorTransport[] | null) ?? [],
      })),
      userVerification: "required",
    });
    await saveChallenge(db, session, "step_up", opts.challenge, purpose);
    return opts;
  };

  /** Vérifie l'assertion contre le défi de la session, puis lui accorde le renforcement. */
  const verifyStepUp = async (
    session: { id: string; orgId: string; userId: string },
    response: AuthenticationResponseJSON,
    via: "page" | "browser",
  ): Promise<{ until: Date } | { error: string; code: number }> => {
    const challenge = await takeChallenge(db, session.id, "step_up");
    const [key] = await db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.userId, session.userId), eq(passkeys.credentialId, response.id)));
    if (!challenge || !key) {
      return { code: 400, error: "défi expiré ou passkey inconnue" };
    }
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: {
        id: key.credentialId,
        publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64")),
        counter: key.counter,
        transports: (key.transports as AuthenticatorTransport[] | null) ?? [],
      },
    }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
    if (!verification.verified) {
      return { code: 403, error: "passkey refusée" };
    }
    await db
      .update(passkeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: sql`now()` })
      .where(eq(passkeys.id, key.id));
    const until = await grantStepUp(db, session.id);
    await appendAudit(db, {
      orgId: session.orgId,
      actor: { type: "user", id: session.userId },
      action: "session.step_up",
      target: { type: "user", id: session.userId },
      data: via === "page" ? { purpose: challenge.purpose } : { purpose: challenge.purpose, via },
    });
    return { until };
  };

  app.get("/v1/passkeys", { preHandler: auth("viewer") }, async (request) => {
    const session = sessionOf(request);
    return db
      .select({
        id: passkeys.id,
        label: passkeys.label,
        createdAt: passkeys.createdAt,
        lastUsedAt: passkeys.lastUsedAt,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, session.userId));
  });

  app.post("/v1/passkeys/register/options", { preHandler: auth("viewer") }, async (request) => {
    const session = sessionOf(request);
    const existing = await db.select().from(passkeys).where(eq(passkeys.userId, session.userId));
    const opts = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: session.login,
      userID: new TextEncoder().encode(session.userId),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        transports: (p.transports as AuthenticatorTransport[] | null) ?? [],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await saveChallenge(db, session, "register", opts.challenge, "register");
    return opts;
  });

  app.post<{ Body: { response: RegistrationResponseJSON; label?: string } }>(
    "/v1/passkeys/register/verify",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const challenge = await takeChallenge(db, session.id, "register");
      if (!challenge) {
        return reply.code(400).send({ error: "défi expiré" });
      }
      const verification = await verifyRegistrationResponse({
        response: request.body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const }));
      if (!verification.verified) {
        return reply.code(400).send({ error: "passkey refusée" });
      }
      const { credential } = verification.registrationInfo;
      await db.insert(passkeys).values({
        orgId: session.orgId,
        userId: session.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: credential.counter,
        transports: credential.transports ?? [],
        label: (request.body.label ?? "Passkey").slice(0, 60),
      });
      await appendAudit(db, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "passkey.registered",
        target: { type: "user", id: session.userId },
      });
      return { ok: true };
    },
  );

  app.post<{ Body: { purpose?: unknown } }>(
    "/v1/step-up/options",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const opts = await authenticationOptions(sessionOf(request), purposeOf(request.body.purpose));
      if (!opts) {
        return reply
          .code(409)
          .send({ error: "aucune passkey : enregistre-en une dans tes réglages" });
      }
      return opts;
    },
  );

  app.post<{ Body: { response: AuthenticationResponseJSON } }>(
    "/v1/step-up/verify",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const result = await verifyStepUp(sessionOf(request), request.body.response, "page");
      if ("error" in result) {
        return reply.code(result.code).send({ error: result.error });
      }
      return { stepUpUntil: result.until };
    },
  );

  // Desktop connecté : la demande est créée avec la session du desktop, puis la passkey est faite
  // dans le navigateur du système, sur ce serveur, sans session : l'identifiant de la demande (à usage
  // unique, 5 minutes) désigne la session à renforcer, et seule une passkey de sa titulaire convient.
  app.post<{ Body: { purpose?: unknown } }>(
    "/v1/step-up/browser",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const session = sessionOf(request);
      if (session.kind !== "desktop") {
        return reply.code(400).send({ error: "réservé à l'app desktop" });
      }
      const id = randomChallenge();
      await saveChallenge(db, session, "browser", id, purposeOf(request.body.purpose));
      return { request: id };
    },
  );

  /** Demande en cours et sa session, encore valide ; jamais celle d'une autre session. */
  const browserRequest = async (id: unknown) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      return undefined;
    }
    const [row] = await db
      .select({
        purpose: webauthnChallenges.purpose,
        session: { id: sessions.id, orgId: sessions.orgId, userId: sessions.userId },
      })
      .from(webauthnChallenges)
      .innerJoin(sessions, eq(sessions.id, webauthnChallenges.sessionId))
      .where(
        and(
          eq(webauthnChallenges.kind, "browser"),
          eq(webauthnChallenges.challenge, id),
          gt(webauthnChallenges.expiresAt, sql`now()`),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return row;
  };

  app.post<{ Body: { request?: unknown } }>(
    "/v1/step-up/browser/options",
    async (request, reply) => {
      const pending = await browserRequest(request.body.request);
      if (!pending) {
        return reply.code(404).send({ error: "demande expirée : recommence depuis l'app" });
      }
      const opts = await authenticationOptions(pending.session, pending.purpose);
      if (!opts) {
        return reply
          .code(409)
          .send({ error: "aucune passkey : enregistre-en une dans tes réglages" });
      }
      return { purpose: pending.purpose, options: opts };
    },
  );

  app.post<{ Body: { request?: unknown; response: AuthenticationResponseJSON } }>(
    "/v1/step-up/browser/verify",
    async (request, reply) => {
      const pending = await browserRequest(request.body.request);
      if (!pending) {
        return reply.code(404).send({ error: "demande expirée : recommence depuis l'app" });
      }
      const result = await verifyStepUp(pending.session, request.body.response, "browser");
      if ("error" in result) {
        return reply.code(result.code).send({ error: result.error });
      }
      // La demande ne sert qu'une fois.
      await takeChallenge(db, pending.session.id, "browser");
      return { ok: true };
    },
  );
}
