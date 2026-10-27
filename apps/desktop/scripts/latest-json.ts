import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestJson } from "../src/release.js";

// Usage (CI) : tsx scripts/latest-json.ts <dossier des paquets> <version> <url de la publication>
const [dir = ".", version = "", baseUrl = ""] = process.argv.slice(2);
const names = readdirSync(dir);
const files = names
  .filter((name) => !name.endsWith(".sig"))
  .map((name) => ({
    name,
    ...(names.includes(`${name}.sig`)
      ? { signature: readFileSync(join(dir, `${name}.sig`), "utf8") }
      : {}),
  }));
const manifest = latestJson(files, {
  version,
  baseUrl,
  notes: `Jules ${version}`,
  date: new Date(),
});
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json : ${Object.keys(manifest.platforms).join(", ")}`);
