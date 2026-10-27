import { describe, expect, it } from "vitest";
import { computeRisk, estimateRisk, sizeOf } from "./risk.js";

const diff = (paths: string[], additions = 10, deletions = 0) => ({ paths, additions, deletions });

describe("taille", () => {
  it.each([
    [diff(["a"], 100, 0), "S"],
    [diff(["a", "b", "c", "d"], 10), "M"],
    [diff(["a"], 300, 100), "M"],
    [diff(["a"], 401), "L"],
    [
      diff(
        Array.from({ length: 11 }, (_, i) => `f${i}`),
        10,
      ),
      "L",
    ],
  ] as const)("%j → %s", (d, size) => {
    expect(sizeOf(d)).toBe(size);
  });
});

describe("risque réel (WORKFLOW.md §3)", () => {
  it.each([
    ["docs", ["docs/guide.md"], {}, "low"],
    ["bug", ["src/pagination.ts"], {}, "low"],
    ["feature", ["src/health.ts"], {}, "medium"],
    ["bug", ["package.json", "pnpm-lock.yaml"], {}, "medium"],
    ["bug", ["src/api/users.ts"], { medium: ["src/api/**"] }, "medium"],
    ["bug", ["src/auth/login.ts"], { high: ["src/auth/**"] }, "high"],
    ["chore", [".github/workflows/ci.yml"], {}, "high"],
    ["bug", ["db/migrations/0003_add.sql"], {}, "high"],
    ["security", ["src/a.ts"], {}, "high"],
  ] as const)("%s sur %j avec %j → %s", (type, paths, config, risk) => {
    expect(computeRisk({ type, diff: diff([...paths]), config }).risk).toBe(risk);
  });

  it("une taille M suffit à passer en medium et le dit", () => {
    expect(computeRisk({ type: "refactor", diff: diff(["a", "b", "c", "d"]), config: {} })).toEqual(
      { risk: "medium", reasons: ["taille M"] },
    );
  });

  it("explique un risque faible", () => {
    expect(
      computeRisk({ type: "test", diff: diff(["test/a.test.ts"]), config: {} }).reasons,
    ).toEqual(["test de taille S sans chemin sensible"]);
  });
});

describe("risque estimé", () => {
  it("ne descend jamais sous l'estimation de l'agent", () => {
    expect(
      estimateRisk({
        type: "docs",
        size: "S",
        likelyAreas: ["README.md"],
        agentEstimate: "high",
        config: {},
      }),
    ).toEqual({
      risk: "high",
      reasons: ["estimation de l'agent : high"],
    });
  });

  it("monte quand les zones probables sont sensibles", () => {
    expect(
      estimateRisk({
        type: "bug",
        size: "S",
        likelyAreas: ["src/auth/session.ts"],
        agentEstimate: "low",
        config: { high: ["src/auth/**"] },
      }).risk,
    ).toBe("high");
  });
});
