import { describe, expect, it } from "vitest";
import {
  checkCommits,
  checkRuleDisables,
  checkTestIntegrity,
  entropy,
  isSourceFile,
  isTestFile,
  scanSecrets,
} from "./checks.js";
import { diffCoverage, parseLcov } from "./coverage.js";
import {
  changedPackages,
  lockfileParser,
  parsePackageLock,
  parsePnpmLock,
  parseRequirements,
  queryOsv,
  severityOf,
} from "./dependencies.js";
import { diffStats, parseCommitLog, parseUnifiedDiff, type FileDiff } from "./diff.js";
import { renderReport, result, verdict } from "./report.js";

const DIFF = `diff --git a/src/health.js b/src/health.js
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/health.js
@@ -0,0 +1,3 @@
+export function health() {
+  return { ok: true };
+}
diff --git a/test/old.test.js b/test/old.test.js
deleted file mode 100644
--- a/test/old.test.js
+++ /dev/null
@@ -1,2 +0,0 @@
-test("a", () => {});
-test("b", () => {});
diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -10,0 +11,2 @@ const x = 1;
+// eslint-disable-next-line no-console
+console.log("x");
@@ -20 +22 @@
-const old = 1;
+const neu = 2;
`;

const file = (path: string, added: string[], extra: Partial<FileDiff> = {}): FileDiff => ({
  path,
  status: "M",
  added: added.map((text, i) => ({ line: i + 1, text })),
  removed: [],
  ...extra,
});

describe("diff", () => {
  it("parse les ajouts, suppressions, fichiers ajoutés et supprimés", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/health.js", "A"],
      ["test/old.test.js", "D"],
      ["src/app.js", "M"],
    ]);
    expect(files[2]?.added).toEqual([
      { line: 11, text: "// eslint-disable-next-line no-console" },
      { line: 12, text: 'console.log("x");' },
      { line: 22, text: "const neu = 2;" },
    ]);
    expect(diffStats(files)).toEqual({ files: 3, additions: 6, deletions: 3 });
    expect(parseUnifiedDiff("bruit\n+sans fichier")).toEqual([]);
  });

  it("parse le journal des commits", () => {
    const log = "aaa\x1ffeat: x\x1fcorps\n\nJules-Task: t1\x1e\nbbb\x1ffix: y\x1f\x1e";
    expect(parseCommitLog(log)).toEqual([
      { sha: "aaa", subject: "feat: x", body: "corps\n\nJules-Task: t1" },
      { sha: "bbb", subject: "fix: y", body: "" },
    ]);
  });
});

describe("G4.2 secrets", () => {
  it.each([
    ["clé AWS", 'const k = "AKIAABCDEFGHIJKLMNOP";'],
    ["jeton GitHub", `token: ghp_${"a1".repeat(18)}`],
    ["clé Anthropic", "ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwx"],
    ["clé privée", "-----BEGIN RSA PRIVATE KEY-----"],
    ["clé privée", 'const pem = "-----BEGIN EC PRIVATE KEY-----\\nMHcCAQEE";'],
    ["clé Stripe", `sk_live_${"x".repeat(24)}`],
    ["valeur secrète (password)", 'password = "Zx9!kQ2#mR7$vT4p"'],
  ])("trouve %s", (kind, text) => {
    expect(scanSecrets([file("src/config.js", [text])])).toEqual([
      { path: "src/config.js", line: 1, kind },
    ]);
  });

  it.each([
    'password = "changeme"',
    'token: "${TOKEN_FROM_ENV}"',
    'apiKey = "aaaaaaaaaaaaaaaa"',
    "const x = 1;",
    // Le nom d'un secret, pas sa valeur ; un en-tête de clé en texte d'exemple.
    'export const GITHUB_APP_KEY_SECRET = "github_app_private_key";',
    'placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"',
  ])("ignore %s", (text) => {
    expect(scanSecrets([file("a.js", [text])])).toEqual([]);
  });

  it("mesure l'entropie", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });
});

describe("G4.3 commits", () => {
  it("exige Conventional Commits et le trailer Jules-Task", () => {
    expect(
      checkCommits(
        [{ sha: "a".repeat(40), subject: "feat(api): ajoute /healthz", body: "Jules-Task: t1" }],
        "t1",
      ),
    ).toEqual([]);
    expect(checkCommits([{ sha: "b".repeat(40), subject: "WIP", body: "" }], "t1")).toEqual([
      "bbbbbbbb : « WIP » n'est pas au format Conventional Commits",
      "bbbbbbbb : trailer Jules-Task manquant",
    ]);
    expect(checkCommits([], "t1")).toEqual(["aucun commit"]);
  });
});

describe("G5.8 intégrité des tests", () => {
  it("détecte un test supprimé, ignoré, isolé ou retiré", () => {
    expect(checkTestIntegrity(parseUnifiedDiff(DIFF))).toEqual([
      "test supprimé : test/old.test.js",
    ]);
    expect(
      checkTestIntegrity([
        file("src/a.test.ts", [
          "  it.skip('marche', () => {});",
          "  test.only('x', () => {})",
          "xit('y')",
        ]),
      ]),
    ).toHaveLength(3);
    expect(
      checkTestIntegrity([file("tests/test_api.py", ["@pytest.mark.skip(reason='flaky')"])]),
    ).toHaveLength(1);
    expect(
      checkTestIntegrity([
        file("src/b.spec.js", [], { removed: ["it('a', () => {})", "it('b', () => {})"] }),
      ]),
    ).toEqual(["src/b.spec.js : 2 test(s) retiré(s)"]);
  });

  it("détecte un seuil de couverture abaissé, mais pas relevé", () => {
    expect(
      checkTestIntegrity([
        file("vitest.config.ts", ["      lines: 50,"], { removed: ["      lines: 90,"] }),
      ]),
    ).toEqual(["vitest.config.ts : seuil lines abaissé de 90 à 50"]);
    expect(
      checkTestIntegrity([
        file("vitest.config.ts", ["      lines: 95,"], { removed: ["      lines: 90,"] }),
      ]),
    ).toEqual([]);
    expect(checkTestIntegrity([file("src/x.ts", ["lines: 1"], { removed: ["lines: 9"] })])).toEqual(
      [],
    );
  });
});

describe("G5.9 désactivations", () => {
  it("liste les nouvelles désactivations de règles", () => {
    expect(checkRuleDisables(parseUnifiedDiff(DIFF))).toEqual([
      "src/app.js:11 : // eslint-disable-next-line no-console",
    ]);
  });
});

describe("G5.6 couverture du diff", () => {
  const lcov = [
    "TN:",
    "SF:/workspace/src/health.js",
    "DA:1,1",
    "DA:2,1",
    "end_of_record",
    "SF:src/app.js",
    "DA:12,0",
    "DA:22,3",
    "end_of_record",
  ].join("\n");

  it("ne compte que les lignes instrumentées, et un fichier absent du rapport comme non couvert", () => {
    const files = parseUnifiedDiff(DIFF);
    const coverage = diffCoverage(files, parseLcov(lcov));
    // health.js : lignes 1 et 2 couvertes, 3 non instrumentée ; app.js : 12 non couverte, 22 couverte, 11 non instrumentée
    expect(coverage).toEqual({
      covered: 3,
      total: 4,
      percent: 75,
      uncovered: [{ path: "src/app.js", line: 12 }],
    });
    expect(diffCoverage([file("src/new.ts", ["const a = 1;", ""])], new Map())).toEqual({
      covered: 0,
      total: 1,
      percent: 0,
      uncovered: [{ path: "src/new.ts", line: 1 }],
    });
    expect(diffCoverage([file("README.md", ["x"])], new Map()).percent).toBe(100);
  });

  it("reconnaît les fichiers de test et de code", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("pkg/handler_test.go")).toBe(true);
    expect(isSourceFile("src/a.ts")).toBe(true);
    expect(isSourceFile("src/a.test.ts")).toBe(false);
    expect(isSourceFile("dist/a.js")).toBe(false);
  });
});

describe("G5.11 dépendances", () => {
  it("lit les lockfiles npm, pnpm et pip", () => {
    expect(
      parsePackageLock(
        JSON.stringify({
          packages: {
            "": {},
            "node_modules/lodash": { version: "4.17.20" },
            "node_modules/a/node_modules/@s/b": { version: "1.0.0" },
            "node_modules/l": { link: true, version: "1" },
          },
        }),
      ),
    ).toEqual([
      { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      { ecosystem: "npm", name: "@s/b", version: "1.0.0" },
    ]);
    expect(
      parsePnpmLock(
        "lockfileVersion: '9.0'\npackages:\n  lodash@4.17.20:\n    resolution: {}\n  '@s/b@1.0.0(react@18.0.0)':\n    resolution: {}\n",
      ),
    ).toEqual([
      { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      { ecosystem: "npm", name: "@s/b", version: "1.0.0" },
    ]);
    expect(parseRequirements("Django==4.2.0\n# commentaire\nrequests>=2\n")).toEqual([
      { ecosystem: "PyPI", name: "django", version: "4.2.0" },
    ]);
    expect(lockfileParser("app/package-lock.json")).toBe(parsePackageLock);
    expect(lockfileParser("yarn.lock")).toBeUndefined();
  });

  it("ne garde que les paquets ajoutés ou changés", () => {
    const before = [{ ecosystem: "npm" as const, name: "a", version: "1.0.0" }];
    const after = [
      ...before,
      { ecosystem: "npm" as const, name: "b", version: "2.0.0" },
      { ecosystem: "npm" as const, name: "b", version: "2.0.0" },
    ];
    expect(changedPackages(before, after)).toEqual([
      { ecosystem: "npm", name: "b", version: "2.0.0" },
    ]);
  });

  it("interroge OSV et lit la sévérité", async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      calls.push(url);
      const body = url.endsWith("querybatch")
        ? { results: [{ vulns: [{ id: "GHSA-1" }] }, {}] }
        : { id: "GHSA-1", summary: "Prototype pollution", database_specific: { severity: "HIGH" } };
      return Promise.resolve(new Response(JSON.stringify(body)));
    }) as typeof fetch;
    const vulns = await queryOsv(
      [
        { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        { ecosystem: "npm", name: "ok", version: "1.0.0" },
      ],
      { fetchImpl, baseUrl: "http://osv" },
    );
    expect(vulns).toEqual([
      {
        id: "GHSA-1",
        package: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        severity: "high",
        summary: "Prototype pollution",
      },
    ]);
    expect(calls).toEqual(["http://osv/v1/querybatch", "http://osv/v1/vulns/GHSA-1"]);
    expect(await queryOsv([])).toEqual([]);
    expect(severityOf({ id: "x", database_specific: { severity: "MODERATE" } })).toBe("medium");
    expect(severityOf({ id: "x" })).toBe("unknown");
  });
});

describe("rapport", () => {
  it("donne le verdict et le tableau", () => {
    const ok = {
      commit: "abc",
      results: [result("G5.5", "pass", "12 tests"), result("G4.4", "warn", "700 lignes")],
    };
    expect(verdict(ok)).toBe("pass");
    expect(
      verdict({ ...ok, results: [...ok.results, result("G5.14", "pending", "CI en cours")] }),
    ).toBe("pending");
    expect(verdict({ ...ok, results: [result("G4.2", "fail", "clé AWS")] })).toBe("fail");
    expect(renderReport(ok)).toContain("| G5.5 | Tests | ✅ pass | 0.0 s | 12 tests |");
  });
});
