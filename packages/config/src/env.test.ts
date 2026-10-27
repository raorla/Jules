import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, loadEnv } from "./env.js";

const schema = z.object({ SECRET: z.string().min(1), PORT: z.coerce.number().default(3000) });

describe("loadEnv", () => {
  it("lit les valeurs et applique les défauts", () => {
    expect(loadEnv(schema, { SECRET: "s" })).toEqual({ SECRET: "s", PORT: 3000 });
  });

  it("lit un secret depuis un fichier", () => {
    const dir = mkdtempSync(join(tmpdir(), "jules-env-"));
    writeFileSync(join(dir, "secret"), "depuis-fichier\n");
    expect(loadEnv(schema, { SECRET_FILE: join(dir, "secret") }).SECRET).toBe("depuis-fichier");
  });

  it("préfère la variable au fichier", () => {
    expect(loadEnv(schema, { SECRET: "direct", SECRET_FILE: "/inexistant" }).SECRET).toBe("direct");
  });

  it("décrit ce qui manque", () => {
    expect(() => loadEnv(schema, {})).toThrow(ConfigError);
    expect(() => loadEnv(schema, {})).toThrow(/SECRET/);
  });
});
