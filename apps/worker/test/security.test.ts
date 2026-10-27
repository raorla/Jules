import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_ORG_ID,
  auditLog,
  deployments,
  eq,
  findings,
  orgs,
  outbox,
  runs,
  serverCommands,
  tasks,
  toolCalls,
} from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { FakeGitHub } from "@jules/forge/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCapability } from "../src/broker/capabilities.js";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { AuditService } from "../src/security/audits.js";
import { devopsBench, remoteWithFiles, type DevopsBench } from "./devops-harness.js";
import { storeEvent, testDeps } from "./harness.js";

// DoD M8 : findings qui bloquent `deploy`, aucune valeur secrète pour l'agent, rien de publié pour un
// repo public. Vraie base, vrais serveurs SSH, vrai git, faux GitHub et faux OSV.

let t: TestDatabase;
let bench: DevopsBench;
let github: FakeGitHub;
let osv: Server;
let audits: AuditService;
let agent: { taskId: string; runId: string };
const VULNERABLE = new Set(["lodash@4.17.15"]);

const LOCK = (version: string) =>
  JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    packages: { "": { name: "app" }, "node_modules/lodash": { version } },
  });

beforeAll(async () => {
  t = await startTestDatabase();
  // Faux OSV : lodash 4.17.15 a une faille connue, de sévérité HIGH.
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
              VULNERABLE.has(`${q.package.name}@${q.version}`)
                ? { vulns: [{ id: "GHSA-p6mc-m468-83gw" }] }
                : {},
            ),
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "GHSA-p6mc-m468-83gw",
            summary: "Prototype pollution in lodash",
            database_specific: { severity: "HIGH" },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => osv.listen(0, "127.0.0.1", resolve));
  github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" });
  bench = devopsBench(t.db, { github });
  audits = new AuditService({
    db: t.db,
    github,
    servers: bench.servers,
    masker: bench.masker,
    log: bench.log,
    runsDir: "/tmp",
    osv: { baseUrl: `http://127.0.0.1:${(osv.address() as AddressInfo).port}` },
  });
  const repo = await bench.repo();
  const [task] = await t.db
    .insert(tasks)
    .values({
      orgId: DEFAULT_ORG_ID,
      repoId: repo.id,
      agent: "security",
      issueNumber: 8000,
      title: "audit",
      request: "audit",
      state: "auditing",
    })
    .returning();
  const [run] = await t.db
    .insert(runs)
    .values({
      orgId: DEFAULT_ORG_ID,
      taskId: task!.id,
      role: "security",
      model: "claude-opus-5-5",
      promptVersion: "security/v1",
      tokenHash: crypto.randomUUID(),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      budgetUsd: "1",
    })
    .returning();
  agent = { taskId: task!.id, runId: run!.id };
}, 600_000);
afterAll(async () => {
  osv.close();
  await bench.stop();
  await t.stop();
});

/** Un appel d'outil de l'agent Sécurité, comme le broker le traite (transaction, puis `after`). */
async function call(name: string, input: unknown) {
  const outcome = await t.db.transaction((tx) =>
    handleCapability(
      tx,
      {
        orgId: DEFAULT_ORG_ID,
        ...agent,
        role: "security",
        stopped: false,
        devops: { servers: bench.servers, plans: bench.plans, playbooks: {} },
        security: { audits, masker: bench.masker },
      },
      name,
      input,
      bench.masker,
    ),
  );
  const text = outcome.after ? await outcome.after() : outcome.text;
  return { status: outcome.status, text };
}

describe("aucune valeur secrète pour l'agent (DoD M8)", () => {
  it("audite un serveur rempli de .env sans jamais en renvoyer une valeur", async () => {
    const { server, host } = await bench.addServer({
      name: "web-secrets",
      environment: "staging",
      level: "D3",
    });
    const SECRETS = [
      "s3cr3t-Postgres-Pa55w0rd-9871",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "sk_live_51HxQ2vLkPqRsTuVwXyZ",
    ];
    await host.exec(
      [
        "mkdir -p /srv/app /srv/billing /opt/legacy",
        `printf 'DB_PASSWORD=${SECRETS[0]}\\nexport GITHUB_TOKEN="${SECRETS[1]}"\\n# commentaire\\n' > /srv/app/.env`,
        `printf 'STRIPE_KEY=${SECRETS[2]}\\n' > /srv/billing/.env.production`,
        `printf 'PASSWORD=${SECRETS[0]}\\n' > /opt/legacy/.env`,
        "chmod 644 /srv/app/.env /srv/billing/.env.production && chmod 600 /opt/legacy/.env",
        "chown -R jules /srv /opt/legacy",
      ].join(" && "),
    );

    const audit = await call("audit_server", { server: "web-secrets" });
    expect(audit.status).toBe(200);
    expect(audit.text).toContain("`DB_PASSWORD` : défini");
    expect(audit.text).toContain("`GITHUB_TOKEN` : défini");
    expect(audit.text).toContain("`STRIPE_KEY` : défini");
    expect(audit.text).toContain("Fichier de secrets lisible par tous");

    // L'agent ne peut pas non plus lire un fichier ni changer quoi que ce soit, même sur un serveur D3.
    expect(
      (
        await call("server_exec", {
          server: "web-secrets",
          command: "cat /srv/app/.env",
          reason: "voir",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("server_exec", {
          server: "web-secrets",
          command: "touch /tmp/x",
          reason: "test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("server_exec", {
          server: "web-secrets",
          command: "ls -la /srv/app",
          reason: "voir",
        })
      ).status,
    ).toBe(200);

    const serverFindings = await t.db
      .select()
      .from(findings)
      .where(eq(findings.targetId, server.id));
    expect(serverFindings.map((f) => `${f.severity} ${f.component}`)).toEqual(
      expect.arrayContaining(["high /srv/app/.env", "high /srv/billing/.env.production"]),
    );
    const stored = await t.db
      .select({ output: serverCommands.output })
      .from(serverCommands)
      .where(eq(serverCommands.serverId, server.id));
    expect(stored.map((s) => s.output)).toContain("sortie non conservée (audit de sécurité)");
    const calls = await t.db
      .select({ input: toolCalls.input, output: toolCalls.output })
      .from(toolCalls);
    const haystacks = [
      audit.text,
      JSON.stringify(serverFindings),
      JSON.stringify(stored),
      JSON.stringify(calls),
      JSON.stringify(await t.db.select({ data: auditLog.data }).from(auditLog)),
      bench.lines.join(""),
    ];
    for (const haystack of haystacks) {
      for (const secret of SECRETS) {
        expect(haystack).not.toContain(secret);
      }
    }
  });
});

describe("publication sur GitHub (WORKFLOW.md §13.2)", () => {
  it("n'envoie rien pour un repo public, et le SARIF et les issues pour un repo privé", async () => {
    const files = {
      "package-lock.json": LOCK("4.17.15"),
      "src/config.js": 'export const api_key = "Zx81-QaP0-vL2m-77Kd-aa91";\n',
    };
    const pub = remoteWithFiles(files);
    const priv = remoteWithFiles(files);
    github.remotes.set("acme/public", pub.remote);
    github.remotes.set("acme/private", priv.remote);
    const publicRepo = await bench.repo(500, "acme/public", false);
    const privateRepo = await bench.repo(501, "acme/private", true);

    const publicAudit = await audits.runNow({
      orgId: DEFAULT_ORG_ID,
      scope: "repo",
      targetId: publicRepo.id,
      trigger: "manual",
    });
    const privateAudit = await audits.runNow({
      orgId: DEFAULT_ORG_ID,
      scope: "repo",
      targetId: privateRepo.id,
      trigger: "manual",
    });
    expect(publicAudit.created).toBe(2);
    expect(privateAudit.created).toBe(2);
    await drainOutbox(testDeps(t.db, github));

    expect(github.sarifs.filter((s) => s.repo === "acme/public")).toEqual([]);
    expect(github.issues.filter((i) => i.repo === "acme/public")).toEqual([]);
    const effects = await t.db.select({ kind: outbox.kind, payload: outbox.payload }).from(outbox);
    expect(effects.filter((e) => JSON.stringify(e.payload).includes(publicAudit.audit.id))).toEqual(
      [],
    );

    const [sarif] = github.sarifs.filter((s) => s.repo === "acme/private");
    expect(sarif).toBeDefined();
    expect(JSON.parse(sarif!.sarif)).toMatchObject({ version: "2.1.0" });
    expect(sarif!.sarif).not.toContain("Zx81");
    const privateIssues = github.issues.filter((i) => i.repo === "acme/private");
    expect(privateIssues.map((i) => i.labels)).toEqual([["security"], ["security"]]);
    expect(privateIssues.map((i) => i.body).join("")).not.toContain("Zx81");

    // Une remédiation sur le repo public est refusée : une issue ou une PR divulguerait la faille.
    await t.db.update(orgs).set({ securityLevel: "S1" }).where(eq(orgs.id, DEFAULT_ORG_ID));
    const [publicFinding] = await t.db
      .select()
      .from(findings)
      .where(eq(findings.targetId, publicRepo.id));
    const refused = await call("propose_remediation", {
      findingId: publicFinding!.id,
      kind: "developer",
      request: "corriger",
    });
    expect(refused).toMatchObject({ status: 403, text: expect.stringContaining("repo public") });
  });
});

describe("blocage des déploiements (DoD M8)", () => {
  it("un finding high ouvert bloque le playbook deploy de sa cible, jusqu'à une décision", async () => {
    const remote = remoteWithFiles({
      ".jules/config.yml":
        "version: 1\ndeploy:\n  staging: { server: app-staging, playbook: deploy }\n",
      ".jules/playbooks.yml": [
        "playbooks:",
        "  deploy:",
        "    params:",
        "      ref: { type: git_sha, required: true }",
        "    steps:",
        "      - run: echo {{ref}} > /tmp/current",
        "    verify:",
        "      - run: cat /tmp/current",
        "    rollback:",
        "      - run: echo {{previous_ref}} > /tmp/current",
        "",
      ].join("\n"),
      "package-lock.json": LOCK("4.17.15"),
    });
    github.remotes.set("acme/shop", remote.remote);
    const repo = await bench.repo(600, "acme/shop", true);
    await bench.addServer({
      name: "app-staging",
      environment: "staging",
      level: "D2",
      repoId: repo.id,
    });
    await audits.runNow({
      orgId: DEFAULT_ORG_ID,
      scope: "repo",
      targetId: repo.id,
      trigger: "manual",
    });
    const [high] = await t.db.select().from(findings).where(eq(findings.targetId, repo.id));
    expect(high).toMatchObject({ severity: "high", status: "open", title: "GHSA-p6mc-m468-83gw" });

    const merge = async (pr: number) => {
      const sha = remote.commit({ [`notes/${pr}.md`]: "x\n" });
      github.setProjectCheck(sha, "ci", "completed", "success");
      await storeEvent(t.db, "pull_request", {
        action: "closed",
        installation: { id: 4242 },
        repository: { id: 600, name: "shop", owner: { login: "acme" }, default_branch: "main" },
        sender: { id: 1, login: "alice", type: "User" },
        pull_request: {
          number: pr,
          merged: true,
          merged_at: new Date().toISOString(),
          merge_commit_sha: sha,
          base: { ref: "main" },
        },
      } as { action: string });
      await drainEvents(testDeps(t.db, github));
      await bench.deployments.advance();
      return sha;
    };

    const blockedSha = await merge(1);
    const [blocked] = await t.db.select().from(deployments).where(eq(deployments.ref, blockedSha));
    expect(blocked).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("GHSA-p6mc-m468-83gw"),
    });

    // L'agent DevOps non plus ne peut pas lancer `deploy` directement.
    const ctx = { orgId: DEFAULT_ORG_ID, ...agent, role: "devops" as const, stopped: false };
    const parsed = await t.db.transaction(async (tx) => {
      const { serverRunPlaybook } = await import("../src/broker/server-tools.js");
      const { parsePlaybooks } = await import("@jules/devops");
      const playbooks = parsePlaybooks(
        'playbooks:\n  deploy:\n    steps:\n      - run: echo ok\n    verify:\n      - run: "true"\n    rollback:\n      - run: "true"\n',
      );
      return serverRunPlaybook(
        tx,
        {
          ...ctx,
          devops: {
            servers: bench.servers,
            plans: bench.plans,
            playbooks: playbooks.ok ? playbooks.value : {},
          },
        },
        { server: "app-staging", name: "deploy", params: {} },
      );
    });
    expect(parsed).toMatchObject({
      status: 403,
      text: expect.stringContaining("finding critique ou haut"),
    });

    // Le risque est accepté par un humain : le déploiement suivant passe.
    await t.db
      .update(findings)
      .set({ status: "accepted_risk", acceptedUntil: new Date(Date.now() + 86_400_000) })
      .where(eq(findings.id, high!.id));
    const sha = await merge(2);
    const [running] = await t.db.select().from(deployments).where(eq(deployments.ref, sha));
    expect(running?.status).toBe("running");
  });
});
