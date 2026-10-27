import { describe, expect, it } from "vitest";
import {
  blocksDeploy,
  dependencyFindings,
  describeInventory,
  dueDate,
  findingKey,
  findingTransition,
  infraFindings,
  isActive,
  parseServerAudit,
  platformFindings,
  reconcile,
  repoPackages,
  secretFindings,
  securityMetrics,
  toSarif,
  type FindingInput,
  type FindingStatus,
} from "./index.js";

const finding = (overrides: Partial<FindingInput> = {}): FindingInput => ({
  scope: "repo",
  targetId: "r1",
  category: "dependency",
  component: "lodash@4.17.15",
  title: "GHSA-p6mc-m468-83gw",
  severity: "high",
  scanner: "osv",
  evidence: "Prototype pollution",
  ...overrides,
});

describe("cycle de vie d'un finding (WORKFLOW.md §13.2)", () => {
  it("suit le diagramme d'états", () => {
    const next = (status: FindingStatus, type: Parameters<typeof findingTransition>[1]["type"]) =>
      findingTransition(status, { type });
    expect(next("open", "triaged")).toEqual({ ok: true, next: "triaged" });
    expect(next("triaged", "remediation_started")).toEqual({ ok: true, next: "in_remediation" });
    expect(next("open", "remediation_started")).toEqual({ ok: true, next: "in_remediation" });
    expect(next("in_remediation", "absent_from_audit")).toEqual({ ok: true, next: "resolved" });
    expect(next("accepted_risk", "absent_from_audit")).toEqual({ ok: true, next: "resolved" });
    expect(next("resolved", "seen_again")).toEqual({ ok: true, next: "open" });
    expect(next("triaged", "accept_risk")).toEqual({ ok: true, next: "accepted_risk" });
    expect(next("open", "false_positive")).toEqual({ ok: true, next: "false_positive" });
    expect(next("accepted_risk", "risk_expired")).toEqual({ ok: true, next: "open" });
    expect(next("false_positive", "reopen")).toEqual({ ok: true, next: "open" });
    expect(next("accepted_risk", "reopen")).toEqual({ ok: true, next: "open" });
  });

  it("refuse les transitions hors du diagramme", () => {
    for (const [status, type] of [
      ["triaged", "triaged"],
      ["resolved", "remediation_started"],
      ["false_positive", "absent_from_audit"],
      ["open", "seen_again"],
      ["in_remediation", "accept_risk"],
      ["in_remediation", "false_positive"],
      ["open", "risk_expired"],
      ["open", "reopen"],
    ] as const) {
      const result = findingTransition(status, { type });
      expect(result.ok, `${status} → ${type}`).toBe(false);
    }
    expect(findingTransition("resolved", { type: "triaged" })).toMatchObject({
      reason: "triaged impossible depuis resolved",
    });
  });

  it("donne les échéances par sévérité", () => {
    const from = new Date(Date.UTC(2026, 9, 1));
    expect(dueDate("critical", from)?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(dueDate("high", from)?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(dueDate("medium", from)?.toISOString()).toBe("2026-12-30T00:00:00.000Z");
    expect(dueDate("low", from)).toBeNull();
  });

  it("bloque les déploiements pour un critique ou un haut actif seulement", () => {
    expect(blocksDeploy({ severity: "high", status: "open" })).toBe(true);
    expect(blocksDeploy({ severity: "critical", status: "in_remediation" })).toBe(true);
    expect(blocksDeploy({ severity: "high", status: "accepted_risk" })).toBe(false);
    expect(blocksDeploy({ severity: "medium", status: "open" })).toBe(false);
    expect(isActive("triaged")).toBe(true);
    expect(isActive("false_positive")).toBe(false);
  });
});

describe("réconciliation d'un audit", () => {
  it("crée, retrouve, rouvre et résout, sans toucher aux scanners non lancés", () => {
    const lodash = finding();
    const minimist = finding({ component: "minimist@1.2.0", title: "GHSA-xvch-5gv4-984h" });
    const existing = [
      { id: "1", key: findingKey(lodash), status: "open" as const, scanner: "osv" },
      { id: "2", key: findingKey(minimist), status: "resolved" as const, scanner: "osv" },
      {
        id: "3",
        key: "repo|r1|dependency|old@1|x",
        status: "in_remediation" as const,
        scanner: "osv",
      },
      { id: "4", key: "repo|r1|secret|a.js:1|s", status: "open" as const, scanner: "secrets" },
      {
        id: "5",
        key: "repo|r1|dependency|fp@1|y",
        status: "false_positive" as const,
        scanner: "osv",
      },
    ];
    const fresh = finding({ component: "axios@0.21.0", title: "GHSA-4w2v-q235-vp99" });
    const result = reconcile(existing, [lodash, lodash, minimist, fresh], ["osv"]);
    expect(result.create).toEqual([fresh]);
    expect(result.seen.map((s) => s.id)).toEqual(["1"]);
    expect(result.reopen.map((s) => s.id)).toEqual(["2"]);
    expect(result.resolve).toEqual(["3"]);
  });

  it("dédoublonne sans tenir compte de la casse ni des espaces", () => {
    expect(findingKey(finding({ title: " GHSA-p6mc-m468-83gw " }))).toBe(
      findingKey(finding({ title: "ghsa-p6mc-m468-83gw" })),
    );
  });
});

describe("audit d'un repo", () => {
  const files = [
    {
      path: "package-lock.json",
      text: JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/lodash": { version: "4.17.15" } },
      }),
    },
    { path: "requirements.txt", text: "requests==2.19.0\n" },
    {
      path: "src/config.js",
      text: 'const api_key = "Zx81-QaP0-vL2m-77Kd-aa91";\nexport default {};\n',
    },
    {
      path: "docker-compose.yml",
      text: "services:\n  app:\n    privileged: true\n    network_mode: host\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    },
    { path: "Dockerfile", text: "FROM node:24\nRUN curl -fsSL https://x.example.com/i.sh | sh\n" },
    { path: "api/Dockerfile", text: "FROM node:24\nUSER node\n" },
    {
      path: "deploy/compose.yaml",
      text: "services:\n  w:\n    volumes:\n      - ${SOCK:-/var/run/docker.sock}:/var/run/docker.sock\n",
    },
  ];

  it("lit les paquets de tous les lockfiles", () => {
    expect(repoPackages([...files, files[0]!]).map((p) => `${p.name}@${p.version}`)).toEqual([
      "lodash@4.17.15",
      "requests@2.19.0",
    ]);
  });

  it("trouve les secrets sans en reproduire la valeur", () => {
    const found = secretFindings("r1", files);
    expect(found).toEqual([
      expect.objectContaining({
        component: "src/config.js:1",
        severity: "critical",
        category: "secret",
      }),
    ]);
    expect(JSON.stringify(found)).not.toContain("Zx81");
  });

  it("applique les règles d'infra", () => {
    expect(infraFindings("r1", files).map((f) => `${f.component} : ${f.title}`)).toEqual([
      "docker-compose.yml : Conteneur privilégié",
      "docker-compose.yml : Conteneur sur le réseau de l'hôte",
      "docker-compose.yml : Socket Docker monté dans un conteneur",
      "Dockerfile : Image exécutée en root (aucun USER)",
      "Dockerfile : Script téléchargé et exécuté pendant la construction",
      "deploy/compose.yaml : Socket Docker monté dans un conteneur",
    ]);
  });

  it("convertit les failles OSV en findings", () => {
    const vulns = [
      {
        id: "GHSA-1",
        package: { ecosystem: "npm" as const, name: "lodash", version: "4.17.15" },
        severity: "high" as const,
        summary: "Prototype pollution",
      },
      {
        id: "GHSA-2",
        package: { ecosystem: "npm" as const, name: "x", version: "1.0.0" },
        severity: "unknown" as const,
        summary: "",
      },
    ];
    expect(dependencyFindings("r1", vulns)).toEqual([
      expect.objectContaining({
        component: "lodash@4.17.15",
        title: "GHSA-1",
        severity: "high",
        evidence: "Prototype pollution",
      }),
      expect.objectContaining({ component: "x@1.0.0", severity: "medium", evidence: "GHSA-2" }),
    ]);
  });
});

describe("audit d'un serveur", () => {
  const output = [
    "FILE\t/srv/app/.env\t644\tdeploy\tDB_PASSWORD,API_TOKEN,",
    "FILE\t/srv/app/.env.local\t620\tdeploy\t",
    "FILE\t/srv/other/.env\t600\tdeploy\tSECRET_KEY,pas un nom,",
    "FILE\t/srv/weird/.env\t604\t\tA",
    "FILE\t/srv/$(rm -rf /)/.env\t644\tx\tA",
    "FILE\t/srv/ok/.env\tabc\tx\tA",
    "SSHD\tPasswordAuthentication yes;PermitRootLogin yes;",
    "PORT\t0.0.0.0:5432",
    "PORT\t127.0.0.1:6379",
    "PORT\t[::]:22",
    "UID0\troot",
    "UID0\ttoor",
    "UPDATES\t3",
    "CONTAINER\t/api\tfalse\t",
    "CONTAINER\t/worker\ttrue\tnode",
    "CONTAINER\t/web\tfalse\tnode",
    "BRUIT\tignoré",
    "",
  ].join("\n");

  it("ne garde que des noms et des états, jamais une valeur", () => {
    const audit = parseServerAudit("s1", output);
    expect(audit.inventory).toEqual([
      {
        path: "/srv/app/.env",
        permissions: "644",
        owner: "deploy",
        variables: ["DB_PASSWORD", "API_TOKEN"],
      },
      { path: "/srv/app/.env.local", permissions: "620", owner: "deploy", variables: [] },
      { path: "/srv/other/.env", permissions: "600", owner: "deploy", variables: ["SECRET_KEY"] },
      { path: "/srv/weird/.env", permissions: "604", owner: "?", variables: ["A"] },
    ]);
    expect(describeInventory(audit.inventory.slice(0, 2))).toBe(
      "/srv/app/.env (droits 644, deploy) : `DB_PASSWORD` : défini, `API_TOKEN` : défini\n/srv/app/.env.local (droits 620, deploy) : aucune variable lisible",
    );
  });

  it("en tire les findings", () => {
    const titles = parseServerAudit("s1", output).findings.map(
      (f) => `${f.severity} ${f.component} : ${f.title}`,
    );
    expect(titles).toEqual([
      "high /srv/app/.env : Fichier de secrets lisible par tous",
      "high /srv/app/.env.local : Fichier de secrets modifiable par d'autres",
      "high /srv/weird/.env : Fichier de secrets lisible par tous",
      "medium sshd : Connexion SSH par mot de passe autorisée",
      "high sshd : Connexion SSH root autorisée",
      "high port 5432 : Base de données exposée sur toutes les interfaces",
      "critical user toor : Autre compte que root avec l'UID 0",
      "medium container api : Conteneur exécuté en root",
      "high container worker : Conteneur privilégié",
      "low paquets : Mises à jour en attente",
    ]);
  });

  it("classe beaucoup de mises à jour en medium, et accepte une sortie vide", () => {
    expect(parseServerAudit("s1", "UPDATES\t80").findings[0]?.severity).toBe("medium");
    expect(parseServerAudit("s1", "UPDATES\tx\nSSHD\nFILE\nPORT\nUID0\nCONTAINER")).toEqual({
      findings: [],
      inventory: [],
    });
    expect(parseServerAudit("s1", "UPDATES")).toEqual({ findings: [], inventory: [] });
  });
});

describe("audit de la plateforme", () => {
  it("signale les réglages risqués", () => {
    const found = platformFindings({
      orgId: "o1",
      admins: [
        { id: "a1", hasPasskey: false },
        { id: "a2", hasPasskey: true },
      ],
      fourEyes: false,
      githubProductionApproval: true,
      servers: [
        { id: "s1", name: "web-1", hostKeyStatus: "changed" },
        { id: "s2", name: "web-2", hostKeyStatus: "trusted" },
      ],
      deniedLast7Days: 42,
    });
    expect(found.map((f) => `${f.severity} ${f.title}`)).toEqual([
      "medium Admin sans passkey",
      "medium Production approuvable depuis GitHub",
      "low Option quatre yeux désactivée",
      "high Clé d'hôte changée non revalidée",
      "low Nombreux refus récents",
    ]);
    expect(
      platformFindings({
        orgId: "o1",
        admins: [{ id: "a1", hasPasskey: true }],
        fourEyes: false,
        githubProductionApproval: false,
        servers: [],
        deniedLast7Days: 0,
      }),
    ).toEqual([]);
  });
});

describe("SARIF et métriques", () => {
  it("exporte les failles du code au format SARIF 2.1.0", () => {
    const sarif = toSarif([
      finding({
        category: "secret",
        component: "src/config.js:12",
        title: "Secret",
        severity: "critical",
      }),
      finding({ severity: "medium" }),
      finding({ category: "config", component: "Dockerfile", title: "Root", severity: "low" }),
    ]) as {
      version: string;
      runs: {
        tool: { driver: { rules: unknown[] } };
        results: { level: string; locations: { physicalLocation: object }[] }[];
      }[];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]!.tool.driver.rules).toHaveLength(3);
    expect(sarif.runs[0]!.results.map((r) => r.level)).toEqual(["error", "warning", "note"]);
    expect(sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: "src/config.js" },
      region: { startLine: 12 },
    });
    expect(sarif.runs[0]!.results[1]!.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: "package.json" },
    });
    expect(sarif.runs[0]!.results[2]!.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: "Dockerfile" },
    });
  });

  it("calcule les métriques de WORKFLOW.md §13.3", () => {
    const day = (d: number) => new Date(Date.UTC(2026, 9, d));
    const row = (o: Partial<Parameters<typeof securityMetrics>[0][number]>) => ({
      severity: "high" as const,
      status: "open" as const,
      scanner: "osv",
      scope: "repo",
      dueAt: day(30),
      firstSeenAt: day(1),
      resolvedAt: null,
      reopenCount: 0,
      ...o,
    });
    const metrics = securityMetrics(
      [
        row({ dueAt: day(5) }),
        row({ scope: "server", scanner: "server-audit", severity: "critical" }),
        row({ status: "resolved", resolvedAt: day(11), reopenCount: 1 }),
        row({ status: "false_positive" }),
        row({ severity: "low", dueAt: null }),
      ],
      day(10),
    );
    expect(metrics).toEqual({
      openBySeverity: { critical: 1, high: 1, medium: 0, low: 1 },
      openByScope: { repo: 2, server: 1 },
      overdueShare: 0.33,
      meanDaysToFix: { critical: null, high: 10, medium: null, low: null },
      reopened: 1,
      falsePositiveRate: { osv: 0.25, "server-audit": 0 },
    });
    expect(securityMetrics([], day(1)).overdueShare).toBeNull();
  });
});
