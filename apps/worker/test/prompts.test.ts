import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { latestPromptVersion } from "../src/prompts.js";
import { ROOT } from "./sandbox-harness.js";

describe("prompts versionnés", () => {
  it("prend la version la plus haute d'un rôle, et ignore le reste", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jules-prompts-"));
    mkdirSync(join(dir, "developer"));
    for (const file of ["v1.md", "v2.md", "v10.md", "v0.md", "v3.md.bak", "notes.md"]) {
      writeFileSync(join(dir, "developer", file), "");
    }
    expect(await latestPromptVersion(dir, "developer")).toBe(10);
    mkdirSync(join(dir, "vide"));
    await expect(latestPromptVersion(dir, "vide")).rejects.toThrow(
      "aucun prompt pour le rôle vide",
    );
  });

  it("chaque rôle du repo a au moins une version", async () => {
    const roles = readdirSync(join(ROOT, "prompts"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(roles.length).toBeGreaterThanOrEqual(9);
    for (const role of roles) {
      expect(await latestPromptVersion(join(ROOT, "prompts"), role)).toBeGreaterThanOrEqual(1);
    }
  });
});
