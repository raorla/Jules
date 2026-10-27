import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApi } from "@jules/api/app";
import {
  DEFAULT_ORG_ID,
  artifacts,
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
