import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exceptionsSchema,
  renderSelfAudit,
  selfAudit,
  selfAuditFailed,
  type SelfAuditException,
} from "../src/security/self-audit.js";
import { ROOT } from "./sandbox-harness.js";

// DoD M11 (ROADMAP.md) : aucun finding critique ou haut n'est ouvert sur Jules. Le dépôt de Jules passe
// par les scanners de son propre agent Sécurité ; les décisions humaines sont dans security/exceptions.json.

let osv: Server;
let osvUrl: string;

beforeAll(async () => {
  // Faux OSV : une faille haute sur lodash 4.17.15, rien d'autre.
  osv = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/querybatch") {
        const { queries } = JSON.parse(body) as {
          queries: { package: { name: string }; version: string }[];
        };
        res.end(
          JSON.stringify({
            results: queries.map((q) =>
              q.package.name === "lodash" && q.version === "4.17.15"
                ? { vulns: [{ id: "GHSA-p6mc-m468-83gw" }] }
                : {},
            ),
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "GHSA-p6mc-m468-83gw",
            summary: "Prototype pollution",
            database_specific: { severity: "HIGH" },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => osv.listen(0, "127.0.0.1", resolve));
  osvUrl = `http://127.0.0.1:${(osv.address() as AddressInfo).port}`;
});
afterAll(() => {
  osv.close();
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jules-self-"));
  execFileSync("git", ["init", "-q", dir]);
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

const now = new Date("2026-10-27T12:00:00Z");

describe("audit de Jules (M11)", () => {
  it("aucun finding critique ou haut n'est ouvert sur le dépôt de Jules, et chaque exception sert", async () => {
    const exceptions = exceptionsSchema.parse(
      JSON.parse(readFileSync(join(ROOT, "security", "exceptions.json"), "utf8")),
    );
    const report = await selfAudit({ root: ROOT, exceptions, now: new Date() });
    expect(report.files).toBeGreaterThan(300);
    expect(report.packages).toBeGreaterThan(500);
    expect(report.open.filter((f) => ["critical", "high"].includes(f.severity))).toEqual([]);
    expect(report.expired).toEqual([]);
    expect(report.stale).toEqual([]);
    // Les risques acceptés ont une échéance, à moins d'un an.
    for (const e of exceptions.filter((x) => x.decision === "accept_risk")) {
      expect(e.until, e.path).toBeDefined();
      expect(Date.parse(e.until!) - Date.now()).toBeLessThan(366 * 86_400_000);
    }
    expect(selfAuditFailed(report)).toBe(false);
  });

  it("un secret ajouté, une faille de dépendance ou un risque expiré font échouer l'audit", async () => {
    const dir = repo({
      // Construite à l'exécution : écrite en clair, elle serait elle-même un finding de l'audit.
      "config.js": `export const key = "${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}";\n`,
      "compose.yaml":
        "services:\n  w:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/lodash": { version: "4.17.15" } },
      }),
    });
    const accepted: SelfAuditException = {
      path: "compose.yaml",
      title: "Socket Docker monté dans un conteneur",
      decision: "accept_risk",
      until: "2026-12-31",
      note: "le worker pilote Docker, hôte dédié",
    };
    const unused: SelfAuditException = {
      path: "ancien.js",
      title: "Secret dans le code : clé AWS",
      decision: "false_positive",
      note: "fichier supprimé depuis",
    };

    const offline = await selfAudit({ root: dir, exceptions: [accepted, unused], now });
    expect(offline.open.map((f) => `${f.severity} ${f.title}`)).toEqual([
      "critical Secret dans le code : clé AWS",
    ]);
    expect(offline.excepted.map((e) => e.exception)).toEqual([accepted]);
    expect(offline.stale).toEqual([unused]);
    expect(selfAuditFailed(offline)).toBe(true);
    expect(renderSelfAudit(offline)).toContain("Exceptions sans objet (à retirer)");

    writeFileSync(join(dir, "config.js"), "export const key = process.env.KEY;\n");
    const withOsv = await selfAudit({
      root: dir,
      exceptions: [accepted],
      now,
      osv: { baseUrl: osvUrl },
    });
    expect(withOsv.scanners).toEqual(["secrets", "infra", "osv"]);
    expect(withOsv.open.map((f) => `${f.severity} ${f.component}`)).toEqual([
      "high lodash@4.17.15",
    ]);
    expect(selfAuditFailed(withOsv)).toBe(true);

    // Le risque accepté a une échéance : passée, le finding redevient ouvert.
    const later = await selfAudit({
      root: dir,
      exceptions: [accepted],
      now: new Date("2027-01-02"),
    });
    expect(later.expired).toEqual([accepted]);
    expect(later.open.some((f) => f.title === accepted.title)).toBe(true);
    expect(selfAuditFailed(later)).toBe(true);
    expect(renderSelfAudit(later)).toContain("Risques acceptés expirés");
  });
});
