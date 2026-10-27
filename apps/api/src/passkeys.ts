import { appendAudit } from "@jules/audit";
import { and, desc, eq, gt, passkeys, sql, webauthnChallenges, type Db } from "@jules/db";
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
// de l'action, même avec une session ouverte. Une session volée ne suffit donc pas.

export type RelyingParty = { id: string; name: string; origin: string };

const CHALLENGE_MINUTES = 5;

export function registerPasskeys(app: FastifyInstance, options: { db: Db; rp: RelyingParty }) {
  const { db, rp } = options;
  const auth = (role: "viewer") => guard({ db, publicOrigin: rp.origin }, role);

  const saveChallenge = async (
    session: { id: string; orgId: string },
    kind: "register" | "step_up",
    challenge: string,
    purpose: string,
  ) => {
    await db.insert(webauthnChallenges).values({
      orgId: session.orgId,
      sessionId: session.id,
      kind,
      challenge,
      purpose,
      expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000),
    });
  };
  /** Le défi est à usage unique : lu puis supprimé. */
  const takeChallenge = async (sessionId: string, kind: "register" | "step_up") => {
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
    await saveChallenge(session, "register", opts.challenge, "register");
    return opts;
  });

  app.post<{ Body: { response: RegistrationResponseJSON; label?: string } }>(
    "/v1/passkeys/register/verify",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const challenge = await takeChallenge(session.id, "register");
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

  app.post<{ Body: { purpose?: string } }>(
    "/v1/step-up/options",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const keys = await db.select().from(passkeys).where(eq(passkeys.userId, session.userId));
      if (keys.length === 0) {
        return reply
          .code(409)
          .send({ error: "aucune passkey : enregistre-en une dans tes réglages" });
      }
      const opts = await generateAuthenticationOptions({
        rpID: rp.id,
        allowCredentials: keys.map((k) => ({
          id: k.credentialId,
          transports: (k.transports as AuthenticatorTransport[] | null) ?? [],
        })),
        userVerification: "required",
      });
      await saveChallenge(
        session,
        "step_up",
        opts.challenge,
        (request.body.purpose ?? "action sensible").slice(0, 100),
      );
      return opts;
    },
  );

  app.post<{ Body: { response: AuthenticationResponseJSON } }>(
    "/v1/step-up/verify",
    { preHandler: auth("viewer") },
    async (request, reply) => {
      const session = sessionOf(request);
      const challenge = await takeChallenge(session.id, "step_up");
      const [key] = await db
        .select()
        .from(passkeys)
        .where(
          and(
            eq(passkeys.userId, session.userId),
            eq(passkeys.credentialId, request.body.response.id),
          ),
        );
      if (!challenge || !key) {
        return reply.code(400).send({ error: "défi expiré ou passkey inconnue" });
      }
      const verification = await verifyAuthenticationResponse({
        response: request.body.response,
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
        return reply.code(403).send({ error: "passkey refusée" });
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
        data: { purpose: challenge.purpose },
      });
      return { stepUpUntil: until };
    },
  );
}
