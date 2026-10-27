import { createHash, randomBytes } from "node:crypto";

// Jeton d'exécution (ARCHITECTURE.md §5) : lisible par l'agent, il n'ouvre que le broker de cette
// exécution, pour les outils de son rôle, et il est révoqué à la fin. Seul son hash est en base.

export function issueRunToken(): { token: string; hash: string } {
  const token = `jrt_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashRunToken(token) };
}

export function hashRunToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}
