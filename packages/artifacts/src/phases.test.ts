import { describe, expect, it } from "vitest";
import { checkDesign, checkSpec, designSchema, specSchema, triageSchema } from "./phases.js";

const spec = specSchema.parse({
  problem: "Pas d'endpoint de santé",
  acceptanceCriteria: [
    { id: "AC-1", given: "le service démarré", when: "GET /healthz", then: "200 et {ok:true}" },
    { id: "AC-2", given: "la base coupée", when: "GET /healthz", then: "503" },
  ],
});

describe("triage (G1)", () => {
  it("exige des questions quand la tâche n'est pas prête", () => {
    expect(
      triageSchema.safeParse({ type: "bug", size: "S", estimatedRisk: "low", ready: false })
        .success,
    ).toBe(false);
    expect(
      triageSchema.safeParse({
        type: "bug",
        size: "S",
        estimatedRisk: "low",
        ready: false,
        questions: ["Quelle page ?"],
      }).success,
    ).toBe(true);
  });

  it("exige un découpage pour une tâche L", () => {
    expect(
      triageSchema.safeParse({ type: "feature", size: "L", estimatedRisk: "medium", ready: true })
        .success,
    ).toBe(false);
  });
});

describe("spec (G2)", () => {
  it("exige au moins un critère et des identifiants uniques AC-n", () => {
    expect(specSchema.safeParse({ problem: "x", acceptanceCriteria: [] }).success).toBe(false);
    expect(
      specSchema.safeParse({
        problem: "x",
        acceptanceCriteria: [{ id: "1", given: "a", when: "b", then: "c" }],
      }).success,
    ).toBe(false);
    const dup = specSchema.safeParse({
      problem: "x",
      acceptanceCriteria: [
        { id: "AC-1", given: "a", when: "b", then: "c" },
        { id: "AC-1", given: "a", when: "b", then: "c" },
      ],
    });
    expect(dup.error?.issues[0]?.message).toBe("identifiant en double : AC-1");
  });

  it("exige la reproduction d'un bug", () => {
    expect(checkSpec(spec, "bug")).toHaveLength(1);
    expect(checkSpec(spec, "feature")).toEqual([]);
  });
});

describe("conception (G3)", () => {
  const design = (acs: string[]) =>
    designSchema.parse({
      approach: "Route Fastify",
      steps: ["Ajouter la route"],
      files: [{ path: "src/health.ts", change: "add", why: "route" }],
      testPlan: acs.map((ac) => ({ ac, level: "unit", test: `test ${ac}` })),
      rollback: "revert",
    });

  it("vérifie que chaque critère a un test prévu", () => {
    expect(checkDesign(design(["AC-1", "AC-2"]), spec)).toEqual([]);
    expect(checkDesign(design(["AC-1", "AC-9"]), spec)).toEqual([
      "G3 : AC-2 n'a aucun test prévu",
      "G3 : AC-9 n'existe pas dans la spec",
    ]);
    expect(checkDesign(design(["AC-1"]), undefined)).toEqual([]);
  });
});
