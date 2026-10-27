import { createHash } from "node:crypto";

// Chaîne de hash du journal d'audit (ARCHITECTURE.md §14, §18).
// Chaque ligne contient le hash de la précédente : modifier, supprimer ou réordonner
// une ligne casse la chaîne à partir de cet endroit.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const GENESIS_HASH = "0".repeat(64);

export type ActorType = "user" | "system" | "agent" | "github";

export type ChainedFields = {
  orgId: string;
  seq: number;
  at: Date;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: JsonValue;
  prevHash: string;
};

/** JSON à clés triées : deux objets égaux donnent toujours la même chaîne, donc le même hash. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("nombre non fini interdit dans l'audit");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(",")}}`;
}

export function hashEntry(fields: ChainedFields): string {
  const payload = canonicalJson({
    v: 1,
    orgId: fields.orgId,
    seq: fields.seq,
    at: fields.at.toISOString(),
    actorType: fields.actorType,
    actorId: fields.actorId,
    action: fields.action,
    targetType: fields.targetType,
    targetId: fields.targetId,
    data: fields.data,
    prevHash: fields.prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Garde-fou §18 : l'audit ne contient que des identifiants internes, jamais de données
// personnelles ni de valeur secrète. Il ne remplace pas la discipline des appelants.
const FORBIDDEN_KEYS = new Set([
  "email",
  "login",
  "username",
  "name",
  "fullname",
  "ip",
  "password",
  "token",
  "secret",
  "privatekey",
  "body",
]);
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

export function assertNoPersonalData(value: JsonValue, path = "data"): void {
  if (typeof value === "string") {
    if (EMAIL.test(value)) {
      throw new TypeError(`${path} ressemble à une adresse e-mail : interdit dans l'audit`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoPersonalData(item, `${path}[${i}]`);
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))) {
      throw new TypeError(
        `${path}.${key} est interdit dans l'audit (identifiants internes seulement)`,
      );
    }
    assertNoPersonalData(item, `${path}.${key}`);
  }
}
