import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApi } from "@jules/api/app";
import {
  DEFAULT_ORG_ID,
  artifacts,
  audits,
  findings,
  changePlans,
  deployments,
  serverCommands,
  servers,
  commands,
  desc,
  installations,
  memberships,
  repos,
  runs,
  tasks,
  toolCalls,
  users,
  workerKeys,
  eq,
} from "@jules/db";
import { startTestDatabase } from "@jules/db/testing";
import sodium from "libsodium-wrappers";

// Serveur des tests Playwright : vraie base PostgreSQL (Testcontainers), vraie api, SPA construite,
// et un faux GitHub OAuth. Le port de contrôle (4311) n'existe que dans les tests.

export const API_PORT = 4310;
export const GITHUB_PORT = 4311;
const PUBLIC_URL = `http://localhost:${API_PORT}`;

const t = await startTestDatabase();
let nextLogin = "root";

const github = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${GITHUB_PORT}`);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/login/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", nextLogin);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() }).end();
    } else if (url.pathname === "/login/oauth/access_token") {
      const { code } = JSON.parse(body) as { code: string };
      res.end(JSON.stringify({ access_token: `gho_${code}` }));
    } else if (url.pathname === "/user") {
      const login = (req.headers.authorization ?? "").replace("Bearer gho_", "");
      const id = Array.from({ length: login.length }, (_, i) => login.charCodeAt(i)).reduce(
        (h, c) => (h * 31 + c) % 1_000_000_007,
        7,
      );
      res.end(JSON.stringify({ id, login }));
    } else if (url.pathname === "/__as" && req.method === "POST") {
      nextLogin = (JSON.parse(body) as { login: string }).login;
      res.end("{}");
    } else if (url.pathname === "/__commands") {
      void t.db
        .select({ name: commands.name, source: commands.source, decision: commands.decision })
        .from(commands)
        .orderBy(desc(commands.createdAt))
        .then((rows) => res.end(JSON.stringify(rows)));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
});
await new Promise<void>((r) => github.listen(GITHUB_PORT, "127.0.0.1", r));

const app = await buildApi({
  db: t.db,
  pool: t.pool,
  publicUrl: PUBLIC_URL,
  oauth: {
    clientId: "e2e",
    clientSecret: "e2e",
    webBase: `http://127.0.0.1:${GITHUB_PORT}`,
    apiBase: `http://127.0.0.1:${GITHUB_PORT}`,
  },
  adminLogins: ["root"],
  webDir: fileURLToPath(new URL("../dist", import.meta.url)),
});

await seed();
await app.listen({ port: API_PORT, host: "localhost" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => github.close())
      .then(() => t.stop())
      .finally(() => process.exit(0));
  });
}

async function seed() {
  await sodium.ready;
  await t.db.insert(workerKeys).values({
    orgId: DEFAULT_ORG_ID,
    publicKey: sodium.to_base64(
      sodium.crypto_box_keypair().publicKey,
      sodium.base64_variants.ORIGINAL,
    ),
  });
  const [viewer] = await t.db
    .insert(users)
    .values({ orgId: DEFAULT_ORG_ID, login: "vera", kind: "human" })
    .returning();
  // Une admin sans passkey, pour vérifier qu'une session seule ne suffit pas.
  const [ada] = await t.db
    .insert(users)
    .values({ orgId: DEFAULT_ORG_ID, login: "ada", kind: "human" })
    .returning();
  await t.db.insert(memberships).values({ orgId: DEFAULT_ORG_ID, userId: ada!.id, role: "admin" });
  await t.db
    .insert(memberships)
    .values({ orgId: DEFAULT_ORG_ID, userId: viewer!.id, role: "viewer" });
  const [installation] = await t.db
    .insert(installations)
    .values({
      orgId: DEFAULT_ORG_ID,
      githubInstallationId: 1001,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .returning();
  const [repo] = await t.db
    .insert(repos)
    .values({
      orgId: DEFAULT_ORG_ID,
      forge: "github",
      installationId: installation!.id,
      githubRepoId: 2002,
      fullName: "acme/factures",
      defaultBranch: "main",
      private: true,
      autonomy: "L1",
    })
    .returning();
  const task = (
    values: Partial<typeof tasks.$inferInsert> & {
      title: string;
      state: typeof tasks.$inferInsert.state;
    },
  ) =>
    t.db
      .insert(tasks)
      .values({
        orgId: DEFAULT_ORG_ID,
        repoId: repo!.id,
        agent: "developer",
        request: "demande",
        ...values,
      })
      .returning()
      .then((rows) => rows[0]!);

  // Une spec qui attend l'approbation ; son texte contient du HTML et du JavaScript (test XSS).
  const export_ = await task({
    title: "Ajouter l'export CSV des factures",
    state: "awaiting_spec_approval",
    issueNumber: 42,
    risk: "medium",
    autonomy: "L1",
    costUsd: "0.42",
    budgetUsd: "5",
  });
  await t.db.insert(artifacts).values([
    {
      orgId: DEFAULT_ORG_ID,
      taskId: export_.id,
      kind: "triage",
      version: 1,
      content: { type: "feature", size: "M", estimatedRisk: "medium", ready: true },
      model: "claude-opus-5-5",
      promptVersion: "triager/v1",
    },
    {
      orgId: DEFAULT_ORG_ID,
      taskId: export_.id,
      kind: "spec",
      version: 1,
      model: "claude-opus-5-5",
      promptVersion: "specifier/v1",
      content: {
        problem: `Les comptables veulent exporter les factures. <img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`,
        acceptanceCriteria: [
          {
            id: "AC1",
            given: "une liste de factures",
            when: "je clique sur Exporter",
            then: "un fichier CSV est téléchargé",
          },
          {
            id: "AC2",
            given: "aucune facture",
            when: "j'exporte",
            then: `<b onmouseover="window.__xss=1">un fichier vide</b>`,
          },
        ],
      },
    },
  ]);

  // Une tâche livrée qui attend la revue humaine : gates, diff, review, coût et runs.
  const vat = await task({
    title: "Corriger l'arrondi de la TVA",
    state: "awaiting_human_review",
    issueNumber: 41,
    risk: "low",
    autonomy: "L1",
    costUsd: "1.84",
    budgetUsd: "5",
    prUrl: "https://github.com/acme/factures/pull/7",
    prNumber: 7,
    branch: "jules/41-tva",
  });
  await t.db.insert(artifacts).values([
    {
      orgId: DEFAULT_ORG_ID,
      taskId: vat.id,
      kind: "spec",
      version: 1,
      model: "claude-opus-5-5",
      promptVersion: "specifier/v1",
      content: {
        problem: "La TVA est arrondie ligne par ligne au lieu du total.",
        acceptanceCriteria: [
          {
            id: "AC1",
            given: "trois lignes à 0,333 €",
            when: "la facture est calculée",
            then: "la TVA est arrondie une seule fois",
          },
        ],
      },
    },
    {
      orgId: DEFAULT_ORG_ID,
      taskId: vat.id,
      kind: "build",
      version: 1,
      model: "claude-opus-5-5",
      promptVersion: "developer/v1",
      content: { summary: "Arrondi déplacé sur le total, test de régression ajouté." },
    },
    {
      orgId: DEFAULT_ORG_ID,
      taskId: vat.id,
      kind: "gate_report",
      version: 1,
      content: {
        commit: "4f2a9c1",
        results: [
          { id: "G4.1", name: "Chemins protégés", status: "pass", durationMs: 12, details: "" },
          { id: "G5.1", name: "Build", status: "pass", durationMs: 8400, details: "" },
          { id: "G5.4", name: "Tests", status: "pass", durationMs: 15200, details: "48 tests" },
          { id: "G5.10", name: "Semgrep", status: "skip", durationMs: 0, details: "non configuré" },
        ],
      },
    },
    {
      orgId: DEFAULT_ORG_ID,
      taskId: vat.id,
      kind: "diff",
      version: 1,
      content: {
        text: "diff --git a/src/vat.ts b/src/vat.ts\nindex 1..2 100644\n--- a/src/vat.ts\n+++ b/src/vat.ts\n@@ -1,3 +1,3 @@\n export function vat(lines: number[]) {\n-  return lines.map((l) => round(l * 0.2)).reduce(sum, 0);\n+  return round(lines.reduce(sum, 0) * 0.2);\n }\n",
      },
    },
    {
      orgId: DEFAULT_ORG_ID,
      taskId: vat.id,
      kind: "review",
      version: 1,
      model: "claude-sonnet-5-5",
      promptVersion: "reviewer/v1",
      content: {
        verdict: "approve",
        summary: "Le critère AC1 est couvert par un test.",
        acVerdicts: [{ ac: "AC1", status: "met", note: "test vat.test.ts" }],
        findings: [],
      },
    },
  ]);
  const [developerRun] = await t.db
    .insert(runs)
    .values([
      {
        orgId: DEFAULT_ORG_ID,
        taskId: vat.id,
        role: "developer",
        model: "claude-opus-5-5",
        promptVersion: "developer/v1",
        status: "succeeded",
        tokenHash: "e2e-1",
        tokenExpiresAt: new Date(),
        budgetUsd: "4",
        costUsd: "1.52",
      },
      {
        orgId: DEFAULT_ORG_ID,
        taskId: vat.id,
        role: "reviewer",
        model: "claude-sonnet-5-5",
        promptVersion: "reviewer/v1",
        status: "succeeded",
        tokenHash: "e2e-2",
        tokenExpiresAt: new Date(),
        budgetUsd: "1",
        costUsd: "0.32",
      },
    ])
    .returning();
  await t.db.insert(toolCalls).values([
    {
      orgId: DEFAULT_ORG_ID,
      runId: developerRun!.id,
      capability: "post_update",
      input: { message: "Je lance les tests avec la clé [masqué]" },
      effect: "allow",
      ruleId: "role.allowed",
      reason: "autorisé",
      output: "ok",
      durationMs: 4,
    },
    {
      orgId: DEFAULT_ORG_ID,
      runId: developerRun!.id,
      capability: "git_push",
      input: {},
      effect: "deny",
      ruleId: "absolute.honeypot",
      reason: "outil piège",
      output: "Refusé par la politique du projet",
      durationMs: 1,
    },
  ]);

  await task({
    title: "Mettre à jour les dépendances",

    state: "done",
    issueNumber: 40,
    risk: "low",
    autonomy: "L1",
    costUsd: "0.95",
  });

  // DevOps (M7) : un serveur de staging validé, une production dont la clé d'hôte attend un admin,
  // un plan de production à approuver avec passkey, des déploiements et l'historique des commandes.
  const [stagingServer] = await t.db
    .insert(servers)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "web-staging",
      host: "10.0.0.11",
      username: "jules",
      environment: "staging",
      level: "D2",
      repoId: repo!.id,
      hostKeyStatus: "trusted",
      hostKeyFingerprint: `SHA256:${"k".repeat(43)}`,
      offeredFingerprint: `SHA256:${"k".repeat(43)}`,
      offeredAlgorithm: "ssh-ed25519",
    })
    .returning();
  const [prodServer] = await t.db
    .insert(servers)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "web-prod",
      host: "10.0.0.21",
      username: "jules",
      environment: "production",
      level: "D1",
      repoId: repo!.id,
      hostKeyStatus: "awaiting_validation",
      offeredFingerprint: `SHA256:${"p".repeat(43)}`,
      offeredAlgorithm: "ssh-ed25519",
    })
    .returning();
  const restart = await task({
    title: "Redémarrer l'API en production",
    state: "awaiting_plan_approval",
    issueNumber: 43,
    risk: "high",
    autonomy: "L1",
    costUsd: "0.31",
  });
  await t.db.update(tasks).set({ agent: "devops" }).where(eq(tasks.id, restart.id));
  const plan = {
    goal: "Redémarrer l'API après la fuite mémoire",
    server: "web-prod",
    environment: "production",
    actions: [
      { kind: "command", command: "sudo -n systemctl restart api", reason: "libérer la mémoire" },
    ],
    impact: "environ 5 s d'indisponibilité de l'API",
    verify: ["systemctl is-active api", "https://api.example.com/health"],
    rollback: ["sudo -n systemctl start api"],
  };
  await t.db.insert(changePlans).values({
    orgId: DEFAULT_ORG_ID,
    taskId: restart.id,
    serverId: prodServer!.id,
    plan,
    steps: [],
    planHash: "e2e",
    environment: "production",
    status: "pending_approval",
    expiresAt: new Date(Date.UTC(2030, 0, 1, 12)),
  });
  await t.db.insert(artifacts).values({
    orgId: DEFAULT_ORG_ID,
    taskId: restart.id,
    kind: "change_plan",
    version: 1,
    model: "claude-opus-5-5",
    promptVersion: "devops/v1",
    content: { planId: "e2e", approvalRequired: true, ...plan },
  });
  await t.db.insert(changePlans).values({
    orgId: DEFAULT_ORG_ID,
    serverId: stagingServer!.id,
    plan: {
      goal: "Déployer 9c41d2e en staging",
      server: "web-staging",
      environment: "staging",
      actions: [{ kind: "playbook", name: "deploy", params: { ref: "9c41d2e" } }],
      impact: "déploiement de 9c41d2e (PR #8)",
      verify: [],
      rollback: [],
    },
    steps: [],
    planHash: "e2e",
    environment: "staging",
    status: "pending_approval",
    expiresAt: new Date(Date.UTC(2030, 0, 1, 12)),
  });
  const day = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h));
  await t.db.insert(deployments).values([
    {
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      serverId: stagingServer!.id,
      environment: "staging",
      ref: "4f2a9c1d0e",
      status: "succeeded",
      playbook: "deploy",
      pullRequests: [7],
      mergedAt: day(20, 9),
      startedAt: day(20, 10),
      endedAt: day(20, 10),
      createdAt: day(20, 10),
    },
    {
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      serverId: prodServer!.id,
      environment: "production",
      ref: "4f2a9c1d0e",
      status: "succeeded",
      playbook: "deploy",
      pullRequests: [7],
      mergedAt: day(20, 9),
      startedAt: day(20, 14),
      endedAt: day(20, 14),
      createdAt: day(20, 14),
    },
    {
      orgId: DEFAULT_ORG_ID,
      repoId: repo!.id,
      serverId: stagingServer!.id,
      environment: "staging",
      ref: "77e0b3a5c2",
      status: "rolled_back",
      playbook: "deploy",
      pullRequests: [8],
      reason: "étape 3 : HTTP 500 (attendu 200) ; retour arrière effectué",
      mergedAt: day(22, 9),
      startedAt: day(22, 10),
      endedAt: day(22, 10),
      createdAt: day(22, 10),
    },
  ]);
  await t.db.insert(serverCommands).values([
    {
      orgId: DEFAULT_ORG_ID,
      serverId: stagingServer!.id,
      source: "agent",
      command: "systemctl status api",
      commandClass: "read",
      decision: "allow",
      ruleId: "server.read",
      exitCode: 0,
      durationMs: 120,
      output: "● api.service - API\n   Active: active (running)",
    },
    {
      orgId: DEFAULT_ORG_ID,
      serverId: stagingServer!.id,
      source: "agent",
      command: "rm -rf /var",
      commandClass: "dangerous",
      decision: "deny",
      ruleId: "absolute.dangerous",
      output: "commande dangereuse, toujours refusée",
    },
  ]);

  // Sécurité (M8) : findings de repo, de serveur et de plateforme, avec l'analyse de l'agent.
  const found = (d: number) => new Date(Date.UTC(2026, 9, d, 8));
  await t.db.insert(findings).values([
    {
      orgId: DEFAULT_ORG_ID,
      scope: "repo",
      targetId: repo!.id,
      key: "repo|lodash",
      category: "dependency",
      component: "lodash@4.17.15",
      title: "GHSA-p6mc-m468-83gw",
      severity: "high",
      status: "triaged",
      scanner: "osv",
      evidence: "Prototype pollution in lodash",
      analysis: "Exploitable : les factures fusionnent des objets venus du client.",
      firstSeenAt: found(20),
      lastSeenAt: found(26),
      dueAt: new Date(Date.UTC(2030, 0, 1)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      scope: "server",
      targetId: stagingServer!.id,
      key: "server|env",
      category: "server",
      component: "/srv/app/.env",
      title: "Fichier de secrets lisible par tous",
      severity: "high",
      status: "open",
      scanner: "server-audit",
      evidence: "droits 644, propriétaire deploy",
      firstSeenAt: found(25),
      lastSeenAt: found(26),
      dueAt: new Date(Date.UTC(2026, 9, 26)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      scope: "platform",
      targetId: DEFAULT_ORG_ID,
      key: "platform|four",
      category: "platform",
      component: "réglages",
      title: "Option quatre yeux désactivée",
      severity: "low",
      status: "open",
      scanner: "platform-audit",
      evidence: "2 admins",
      analysis: "Une seule personne opère la production : faux positif probable.",
      falsePositiveSuggested: true,
      firstSeenAt: found(21),
      lastSeenAt: found(26),
    },
    {
      orgId: DEFAULT_ORG_ID,
      scope: "repo",
      targetId: repo!.id,
      key: "repo|secret",
      category: "secret",
      component: "src/config.js:12",
      title: "Secret dans le code : jeton GitHub",
      severity: "critical",
      status: "resolved",
      scanner: "secrets",
      evidence: "jeton GitHub en clair (valeur non reproduite)",
      firstSeenAt: found(10),
      lastSeenAt: found(12),
      resolvedAt: found(14),
      dueAt: found(17),
    },
  ]);
  await t.db.insert(audits).values([
    {
      orgId: DEFAULT_ORG_ID,
      scope: "repo",
      targetId: repo!.id,
      trigger: "merge",
      status: "succeeded",
      scanners: ["secrets", "infra", "osv"],
      summary: { created: 1, resolved: 1, active: 1 },
      createdAt: found(26),
      endedAt: found(26),
    },
    {
      orgId: DEFAULT_ORG_ID,
      scope: "server",
      targetId: stagingServer!.id,
      trigger: "schedule",
      status: "succeeded",
      scanners: ["server-audit"],
      summary: { created: 1, resolved: 0, active: 1 },
      createdAt: found(25),
      endedAt: found(25),
    },
  ]);
  await task({
    title: "Migrer la base vers PostgreSQL 18",
    state: "blocked",
    issueNumber: 39,
    risk: "high",
    autonomy: "L0",
    costUsd: "2.10",
    lastError: "G5.4 Tests : 3 échecs après 3 itérations",
  });
}
