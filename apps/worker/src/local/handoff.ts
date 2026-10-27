import { request } from "node:http";
import { Keyring, parseMasterKey } from "@jules/secrets";
import { z } from "zod";

// Mode local (M10, ARCHITECTURE.md §4.7) : la clé maître vit dans le trousseau du système. Le desktop
// la remet au worker au démarrage, une seule fois, par un point d'accès éphémère : un socket Unix monté
// dans le conteneur (Linux) ou une adresse de bouclage jointe par `host.docker.internal` (Docker
// Desktop). Le jeton d'accès, lui, peut traîner dans la config du conteneur : il ne sert qu'une fois.

const payload = z
  .object({
    masterKey: z.string().min(1),
    previousKeys: z.array(z.string().min(1)).max(5).default([]),
    /** Accès au modèle rangé dans le trousseau : une clé API, ou le jeton d'un abonnement Claude. */
    anthropicApiKey: z.string().min(1).optional(),
    claudeOauthToken: z.string().min(1).optional(),
  })
  .refine((data) => !(data.anthropicApiKey && data.claudeOauthToken), {
    message: "un seul accès au modèle",
  });

export type Handoff = { keyring: Keyring; anthropicApiKey?: string; claudeOauthToken?: string };

export class HandoffError extends Error {}

/** `unix:/run/jules/handoff.sock` ou `http://host.docker.internal:43127/handoff`. */
export function parseHandoffUrl(
  url: string,
): { socketPath: string; path: string } | { host: string; port: number; path: string } {
  if (url.startsWith("unix:")) {
    return { socketPath: url.slice("unix:".length), path: "/handoff" };
  }
  const parsed = new URL(url);
  // Jamais une adresse publique : la clé ne doit traverser aucun réseau.
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "host.docker.internal"].includes(parsed.hostname)
  ) {
    throw new HandoffError(
      "adresse de remise refusée : bouclage ou host.docker.internal seulement",
    );
  }
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: Number(parsed.port || 80),
    path: parsed.pathname || "/handoff",
  };
}

export async function receiveHandoff(
  url: string,
  token: string,
  timeoutMs = 10_000,
): Promise<Handoff> {
  const target = parseHandoffUrl(url);
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        ...target,
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": "0" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          try {
            if (res.statusCode !== 200) {
              reject(new HandoffError(`remise des secrets refusée (HTTP ${res.statusCode ?? 0})`));
              return;
            }
            const data = payload.parse(JSON.parse(body.toString("utf8")));
            const keyring = new Keyring(
              parseMasterKey(data.masterKey),
              data.previousKeys.map(parseMasterKey),
            );
            resolve({
              keyring,
              ...(data.anthropicApiKey ? { anthropicApiKey: data.anthropicApiKey } : {}),
              ...(data.claudeOauthToken ? { claudeOauthToken: data.claudeOauthToken } : {}),
            });
          } catch (error) {
            reject(error instanceof HandoffError ? error : new HandoffError("remise illisible"));
          } finally {
            body.fill(0);
            for (const c of chunks) c.fill(0);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new HandoffError("remise des secrets : délai dépassé")));
    req.on("error", (error) => {
      reject(error instanceof HandoffError ? error : new HandoffError(error.message));
    });
    req.end();
  });
}
