import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };

// Règles de DESIGN.md vérifiées sur le code : mêmes clés dans les deux langues, aucun HTML injecté,
// et aucune couleur en dur hors des tokens du skill.

const src = join(import.meta.dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
const keys = (o: object, prefix = ""): string[] =>
  Object.entries(o)
    .flatMap(([k, v]) =>
      typeof v === "object" && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
    )
    .sort();

describe("garde-fous de l'interface", () => {
  it("le français et l'anglais ont exactement les mêmes clés", () => {
    expect(keys(en)).toEqual(keys(fr));
  });

  it("aucun composant n'injecte de HTML", () => {
    for (const file of files(src).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/);
    }
  });

  it("les couleurs passent par les rôles : aucune valeur hexadécimale hors de tokens.css", () => {
    for (const file of files(src).filter(
      (f) => /\.(tsx?|css)$/.test(f) && !f.endsWith("tokens.css"),
    )) {
      expect(readFileSync(file, "utf8").match(/#[0-9a-fA-F]{3,8}\b/g), file).toBeNull();
    }
  });
});
