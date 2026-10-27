import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, memberships, sessions, sql, users, type Db } from "@jules/db";
import type { JulesRole } from "@jules/commands";
import type { FastifyReply, FastifyRequest } from "fastify";

// Sessions (ARCHITECTURE.md §4.2) : cookie HttpOnly, Secure, SameSite=Strict sur le web, jeton porteur
// sur le desktop. Seul le hash du jeton est stocké. Toute écriture web exige le jeton CSRF de la session.

export const SESSION_COOKIE = "jules_session";
export const CSRF_HEADER = "x-jules-csrf";
const STEP_UP_MINUTES = 5;

export type Session = {
  id: string;
  orgId: string;
  kind: "web" | "desktop";
  userId: string;
  login: string;
  role: JulesRole;
  csrfToken: string;
  stepUpUntil: Date | null;
};

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(
  db: Db,
  input: { orgId: string; userId: string; kind: "web" | "desktop"; ttlHours: number },
) {
  const token = `${input.kind === "web" ? "jws" : "jds"}_${randomBytes(32).toString("base64url")}`;
  const csrfToken = randomBytes(24).toString("base64url");
  await db.insert(sessions).values({
    orgId: input.orgId,
    userId: input.userId,
    kind: input.kind,
    tokenHash: hashToken(token),
    csrfToken,
    expiresAt: new Date(Date.now() + input.ttlHours * 3600_000),
  });
  return { token, csrfToken };
}

function bearerToken(request: FastifyRequest): string | undefined {
  return /^Bearer\s+(jds_\S+)$/.exec(request.headers.authorization ?? "")?.[1];
}

export async function loadSession(db: Db, request: FastifyRequest): Promise<Session | undefined> {
  const token = request.cookies[SESSION_COOKIE] ?? bearerToken(request);
  if (!token) {
    return undefined;
  }
  const [row] = await db
    .select({ session: sessions, login: users.login, role: memberships.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.orgId, sessions.orgId)),
    )
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
      ),
    );
  if (!row) {
    return undefined;
  }
  // Le type de jeton doit correspondre au type de session : un jeton desktop ne vaut pas cookie web.
  const viaCookie = request.cookies[SESSION_COOKIE] !== undefined;
  if ((row.session.kind === "web") !== viaCookie) {
    return undefined;
  }
  return {
    id: row.session.id,
    orgId: row.session.orgId,
    kind: row.session.kind,
    userId: row.session.userId,
    login: row.login,
    role: row.role,
    csrfToken: row.session.csrfToken,
    stepUpUntil: row.session.stepUpUntil,
  };
}

export async function grantStepUp(db: Db, sessionId: string): Promise<Date> {
  const until = new Date(Date.now() + STEP_UP_MINUTES * 60_000);
  await db.update(sessions).set({ stepUpUntil: until }).where(eq(sessions.id, sessionId));
  return until;
}

const ROLE_ORDER: JulesRole[] = ["admin", "maintainer", "member", "viewer"];
export const hasJulesRole = (role: JulesRole, required: JulesRole) =>
  ROLE_ORDER.indexOf(role) <= ROLE_ORDER.indexOf(required);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Garde d'une route : session valide, rôle suffisant, et pour une écriture web, jeton CSRF et origine.
 * `stepUp` : action sensible, passkey exigée au moment même de l'action (§4.2).
 */
export function guard(
  options: { db: Db; publicOrigin: string },
  required: JulesRole,
  guardOptions: { stepUp?: boolean } = {},
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await loadSession(options.db, request);
    if (!session) {
      return reply.code(401).send({ error: "non connecté" });
    }
    const writes = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (writes && session.kind === "web") {
      const origin = request.headers.origin;
      const csrf = request.headers[CSRF_HEADER];
      if (
        (origin !== undefined && origin !== options.publicOrigin) ||
        typeof csrf !== "string" ||
        !safeEqual(csrf, session.csrfToken)
      ) {
        return reply.code(403).send({ error: "requête refusée (CSRF)" });
      }
    }
    if (!hasJulesRole(session.role, required)) {
      return reply.code(403).send({ error: `rôle ${required} requis` });
    }
    if (guardOptions.stepUp && (!session.stepUpUntil || session.stepUpUntil < new Date())) {
      return reply.code(403).send({ error: "passkey requise pour cette action", stepUp: true });
    }
    request.session = session;
    return undefined;
  };
}

/** Session d'une requête déjà passée par `guard` ; son absence est une erreur de câblage. */
export function sessionOf(request: FastifyRequest): Session {
  if (!request.session) {
    throw new Error("route sans garde : session absente");
  }
  return request.session;
}
