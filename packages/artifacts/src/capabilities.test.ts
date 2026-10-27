import { describe, expect, it } from "vitest";
import { capabilityInputs, isCapabilityName } from "./capabilities.js";

describe("entrées des outils", () => {
  it("valide un submit_build en Conventional Commits", () => {
    const ok = capabilityInputs.submit_build.safeParse({
      summary: "Ajout de /healthz",
      commitMessage: "feat(api): ajoute /healthz",
    });
    expect(ok.success && ok.data.testsAdded).toEqual([]);
    expect(
      capabilityInputs.submit_build.safeParse({ summary: "x", commitMessage: "ajout" }).success,
    ).toBe(false);
  });

  it("borne set_plan et ask_human", () => {
    expect(capabilityInputs.set_plan.safeParse({ steps: [] }).success).toBe(false);
    expect(capabilityInputs.set_plan.safeParse({ steps: Array(16).fill("x") }).success).toBe(false);
    expect(capabilityInputs.ask_human.safeParse({ questions: Array(6).fill("?") }).success).toBe(
      false,
    );
    expect(capabilityInputs.post_update.safeParse({ message: "x".repeat(2001) }).success).toBe(
      false,
    );
  });

  it("reconnaît les noms d'outils sans se laisser abuser par le prototype", () => {
    expect(isCapabilityName("post_update")).toBe(true);
    expect(isCapabilityName("toString")).toBe(false);
  });
});
