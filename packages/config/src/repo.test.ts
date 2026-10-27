import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_CONFIG,
  effectiveAutonomy,
  effectiveBudget,
  parseRepoConfig,
} from "./repo.js";

const example = `
version: 1
language: en
commands:
  test: pnpm test --coverage
risk:
  high: ["src/auth/**"]
egress:
  allow: ["registry.npmjs.org", "*.pythonhosted.org"]
budgets:
  max_cost_usd: 15
`;

describe("config du repo", () => {
  it("lit l'exemple d'ARCHITECTURE.md §13", () => {
    const { config, errors } = parseRepoConfig(example);
    expect(errors).toEqual([]);
    expect(config).toMatchObject({
      language: "en",
      risk: { high: ["src/auth/**"] },
      budgets: { max_cost_usd: 15 },
      gates: { diff_coverage_min: 80 },
    });
  });

  it("retombe sur les défauts quand la config est absente, invalide ou d'une autre version", () => {
    expect(parseRepoConfig(undefined)).toEqual({ config: DEFAULT_REPO_CONFIG, errors: [] });
    expect(parseRepoConfig("version: [").errors[0]).toMatch(/^YAML invalide/);
    expect(parseRepoConfig("version: 2").errors).toHaveLength(1);
    expect(parseRepoConfig("version: 1\negress:\n  allow: ['http://evil/x']").errors[0]).toContain(
      "egress.allow",
    );
  });

  it("refuse une bombe d'alias YAML", () => {
    const bomb = [
      "a: &a [x,x,x,x,x,x,x,x,x]",
      ...Array.from(
        { length: 9 },
        (_, i) =>
          `${"bcdefghij"[i]}: &${"bcdefghij"[i]} [${Array(9).fill(`*${"abcdefghij"[i]}`).join(",")}]`,
      ),
    ].join("\n");
    expect(parseRepoConfig(bomb).errors[0]).toMatch(/YAML invalide|alias/i);
  });

  it("ne peut que baisser l'autonomie et le budget", () => {
    expect(effectiveAutonomy("L1", "L2")).toBe("L1");
    expect(effectiveAutonomy("L2", "L0")).toBe("L0");
    expect(effectiveAutonomy("L2", undefined)).toBe("L2");
    expect(
      effectiveBudget(15, parseRepoConfig("version: 1\nbudgets:\n  max_cost_usd: 50").config),
    ).toBe(15);
    expect(
      effectiveBudget(15, parseRepoConfig("version: 1\nbudgets:\n  max_cost_usd: 5").config),
    ).toBe(5);
  });
});
