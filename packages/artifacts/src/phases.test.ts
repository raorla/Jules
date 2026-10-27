import { describe, expect, it } from "vitest";
import {
  checkDesign,
  checkSpec,
  designSchema,
  gateG6,
  reviewSchema,
  specSchema,
  triageSchema,
} from "./phases.js";

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

describe("review (G6)", () => {
  const review = (overrides: Record<string, unknown>) =>
    reviewSchema.parse({
      verdict: "approve",
      summary: "ok",
      acVerdicts: [
        { ac: "AC-1", status: "met" },
        { ac: "AC-2", status: "met" },
      ],
      ...overrides,
    });

  it("passe quand tout est met et sans finding bloquant", () => {
    expect(
      gateG6(review({ findings: [{ severity: "nit", file: "a.ts", comment: "nom" }] }), spec),
    ).toEqual({ outcome: "approved", problems: [] });
  });

  it("renvoie en développement un critère non implémenté, même si le verdict dit approve", () => {
    expect(
      reviewSchema.safeParse({
        verdict: "approve",
        summary: "x",
        acVerdicts: [{ ac: "AC-1", status: "missing" }],
      }).success,
    ).toBe(false);
    const missing = review({
      verdict: "request_changes",
      acVerdicts: [
        { ac: "AC-1", status: "met" },
        { ac: "AC-2", status: "missing", note: "pas de 503" },
      ],
    });
    expect(gateG6(missing, spec)).toEqual({
      outcome: "changes_requested",
      problems: ["AC-2 non implémenté : pas de 503"],
    });
    expect(gateG6(review({ acVerdicts: [{ ac: "AC-1", status: "met" }] }), spec).problems).toEqual([
      "AC-2 non évalué par le reviewer",
    ]);
  });

  it("bloque sur un finding major ou blocker, et escalade si demandé", () => {
    expect(
      gateG6(
        review({
          findings: [{ severity: "major", file: "a.ts", line: 3, comment: "injection SQL" }],
        }),
        spec,
      ).problems,
    ).toEqual(["major a.ts:3 : injection SQL"]);
    expect(gateG6(review({ verdict: "escalate" }), spec).outcome).toBe("escalated");
    expect(gateG6(review({ verdict: "request_changes" }), spec).problems).toEqual([
      "changements demandés par le reviewer",
    ]);
    expect(
      gateG6(
        review({
          acVerdicts: [
            { ac: "AC-1", status: "partial" },
            { ac: "AC-2", status: "met" },
          ],
          verdict: "request_changes",
        }),
        undefined,
      ).outcome,
    ).toBe("changes_requested");
  });
});
