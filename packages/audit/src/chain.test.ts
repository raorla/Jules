import { describe, expect, it } from "vitest";
import { GENESIS_HASH, assertNoPersonalData, canonicalJson, hashEntry } from "./chain.js";

describe("canonicalJson", () => {
  it("trie les clés à tous les niveaux", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it("refuse les nombres non finis", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError);
  });
});

describe("hashEntry", () => {
  const fields = {
    orgId: "org",
    seq: 1,
    at: new Date("2026-10-27T10:00:00.000Z"),
    actorType: "system",
    actorId: "worker",
    action: "task.created",
    targetType: "task",
    targetId: "t1",
    data: { b: 2, a: 1 },
    prevHash: GENESIS_HASH,
  };

  it("ne dépend pas de l'ordre des clés", () => {
    expect(hashEntry(fields)).toBe(hashEntry({ ...fields, data: { a: 1, b: 2 } }));
  });

  it("change si un seul champ change", () => {
    const base = hashEntry(fields);
    expect(hashEntry({ ...fields, seq: 2 })).not.toBe(base);
    expect(hashEntry({ ...fields, actorId: "other" })).not.toBe(base);
    expect(hashEntry({ ...fields, prevHash: "1".repeat(64) })).not.toBe(base);
    expect(hashEntry({ ...fields, at: new Date("2026-10-27T10:00:00.001Z") })).not.toBe(base);
  });
});

describe("assertNoPersonalData", () => {
  it("accepte des identifiants internes", () => {
    expect(() => {
      assertNoPersonalData({ userId: "8f0c", issue: 12, labels: ["jules"], mention: "@jules" });
    }).not.toThrow();
  });

  it.each([
    [{ email: "x" }],
    [{ nested: { login: "octocat" } }],
    [{ user_name: "x" }],
    [{ list: [{ Token: "x" }] }],
    [{ note: "écrire à jane.doe@example.com" }],
  ])("refuse %j", (data) => {
    expect(() => {
      assertNoPersonalData(data);
    }).toThrow(TypeError);
  });
});
