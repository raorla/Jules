import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORG_ID, eq, findings, orgs, runs, tasks } from "@jules/db";
import { startTestDatabase, type TestDatabase } from "@jules/db/testing";
import { requiredHumanGates } from "@jules/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCapability } from "../src/broker/capabilities.js";
import { Masker } from "../src/broker/masking.js";
import { drainEvents } from "../src/inbox.js";
import { drainOutbox } from "../src/outbox.js";
import { AuditService } from "../src/security/audits.js";
import { ServerService } from "../src/devops/servers.js";
import { startFakeModel, type FakeModel } from "./fake-model.js";
import { seedTask, storeEvent, testDeps } from "./harness.js";
import { ensureTestImages } from "./images.js";
import { sandboxSetup } from "./sandbox-harness.js";
import { Keyring, SecretStore, generateMasterKey, parseMasterKey } from "@jules/secrets";

// DoD M8, de bout en bout : sur un repo qui contient une faille connue, un finding est créé, puis une
// tâche de remédiation, puis une PR (vrai agent développeur dans le sandbox), et le finding passe en
// `resolved` après le nouvel audit déclenché par le merge.

let t: TestDatabase;
let model: FakeModel;
let osv: Server;

const LOCK = (version: string) =>
  `${JSON.stringify({ name: "sandbox", lockfileVersion: 3, packages: { "": { name: "sandbox" }, "node_modules/lodash": { version } } }, null, 2)}\n`;

beforeAll(async () => {
  t = await startTestDatabase();
  await ensureTestImages();
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
            summary: "Prototype pollution in lodash",
            database_specific: { severity: "HIGH" },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => osv.listen(0, "127.0.0.1", resolve));
}, 900_000);
afterAll(async () => {
  await model.close();
  osv.close();
  await t.stop();
});

describe("cycle complet d'un finding (M8)", () => {
  it("finding, tâche de remédiation, PR, puis finding résolu au nouvel audit", async () => {
    model = await startFakeModel({
      build: [
        {
          tool: "Write",
          input: { file_path: "/workspace/package-lock.json", content: LOCK("4.17.21") },
        },
        {
          tool: "mcp__jules__submit_build",
          input: {
            summary: "Met à jour lodash en 4.17.21 (GHSA-p6mc-m468-83gw).",
            commitMessage: "fix(deps): met à jour lodash",
          },
        },
        { text: "Terminé." },
      ],
    });
    const setup = sandboxSetup(t.db, model);
    const deps = testDeps(t.db, setup.github);
    // Le repo de test contient une dépendance vulnérable sur main.
    const seed = mkdtempSync(join(tmpdir(), "jules-m8-"));
    const g = (...args: string[]) =>
      execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
        .toString()
        .trim();
    execFileSync("git", ["clone", "-q", setup.remote, seed]);
    writeFileSync(join(seed, "package-lock.json"), LOCK("4.17.15"));
    g("add", "-A");
    g("commit", "-q", "-m", "chore: lockfile");
    g("push", "-q", "origin", "main");

    const { repo, task: securityTask } = await seedTask(t.db, {
      state: "received",
      title: "Audit",
    });
    await t.db
      .update(tasks)
      .set({ agent: "security", state: "auditing" })
      .where(eq(tasks.id, securityTask.id));
    const [run] = await t.db
      .insert(runs)
      .values({
        orgId: DEFAULT_ORG_ID,
        taskId: securityTask.id,
        role: "security",
        model: "claude-opus-5-5",
        promptVersion: "security/v1",
        tokenHash: crypto.randomUUID(),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        budgetUsd: "1",
      })
      .returning();
    const masker = new Masker([]);
    const store = new SecretStore(t.db, new Keyring(parseMasterKey(generateMasterKey())));
    const audits = new AuditService({
      db: t.db,
      github: setup.github,
      servers: new ServerService({ db: t.db, secrets: store, masker, log: setup.log }),
      masker,
      log: setup.log,
      runsDir: setup.runsDir,
      osv: { baseUrl: `http://127.0.0.1:${(osv.address() as AddressInfo).port}` },
    });

    // 1. L'audit (outil de l'agent Sécurité, exécuté par le worker) crée le finding.
    const callAgent = async (name: string, input: unknown) => {
      const outcome = await t.db.transaction((tx) =>
        handleCapability(
          tx,
          {
            orgId: DEFAULT_ORG_ID,
            runId: run!.id,
            taskId: securityTask.id,
            role: "security",
            stopped: false,
            security: { audits, masker },
          },
          name,
          input,
          masker,
        ),
      );
      return { status: outcome.status, text: outcome.after ? await outcome.after() : outcome.text };
    };
    const audit = await callAgent("audit_repo", {});
    expect(audit.text).toContain("GHSA-p6mc-m468-83gw");
    const [finding] = await t.db.select().from(findings).where(eq(findings.targetId, repo.id));
    expect(finding).toMatchObject({
      severity: "high",
      status: "open",
      component: "lodash@4.17.15",
    });
    await drainOutbox(deps);
    const issue = setup.github.issues.find((i) => i.labels?.includes("security"));
    expect(issue).toMatchObject({ state: "open" });

    // 2. L'agent l'analyse, puis propose la remédiation (S1) : une tâche développeur de type security.
    expect(
      (
        await callAgent("report_finding", {
          findingId: finding!.id.slice(0, 8),
          analysis: "Exploitable via merge d'objets utilisateur.",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await callAgent("propose_remediation", {
          findingId: finding!.id,
          kind: "developer",
          request: "Mettre lodash à jour.",
        })
      ).status,
    ).toBe(403);
    await t.db.update(orgs).set({ securityLevel: "S1" }).where(eq(orgs.id, DEFAULT_ORG_ID));
    expect(
      (
        await callAgent("propose_remediation", {
          findingId: finding!.id,
          kind: "developer",
          request: "Mettre lodash à jour en 4.17.21.",
        })
      ).status,
    ).toBe(200);
    const [linked] = await t.db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(linked?.status).toBe("in_remediation");
    const [remediation] = await t.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, linked!.remediationTaskId!));
    expect(remediation).toMatchObject({
      agent: "developer",
      type: "security",
      risk: "high",
      state: "received",
    });
    expect(requiredHumanGates({ autonomy: "L2", type: "security", risk: "high" })).toEqual({
      h1: true,
      h2: true,
    });
    await drainOutbox(deps);
    const [withIssue] = await t.db.select().from(tasks).where(eq(tasks.id, remediation!.id));
    expect(withIssue?.issueNumber).not.toBeNull();

    // 3. Spec et conception approuvées (H1, H2 : prouvées en M2) ; le vrai agent développeur livre la PR.
    await t.db
      .update(tasks)
      .set({ state: "building", autonomy: "L2", size: "S", language: "fr" })
      .where(eq(tasks.id, remediation!.id));
    await setup.orchestrator.drainTasks();
    await setup.orchestrator.idle();
    await drainOutbox(deps);
    const pr = setup.github.pullRequests.find((p) =>
      p.head.startsWith(`jules/${withIssue!.issueNumber}`),
    );
    expect(pr).toBeDefined();

    // 4. Un humain merge la PR : le merge relance l'audit du repo, qui ne retrouve plus la faille.
    g("fetch", "-q", "origin");
    g("merge", "-q", "--no-ff", "-m", "Merge PR", `origin/${pr!.head}`);
    g("push", "-q", "origin", "main");
    await storeEvent(t.db, "pull_request", {
      action: "closed",
      installation: { id: 4242 },
      repository: { id: 99, name: "sandbox", owner: { login: "acme" }, default_branch: "main" },
      sender: { id: 1, login: "alice", type: "User" },
      pull_request: {
        number: pr!.number,
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: g("rev-parse", "HEAD"),
        base: { ref: "main" },
      },
    } as { action: string });
    await drainEvents(deps);
    expect(await audits.drain()).toBe(1);
    const [resolved] = await t.db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(resolved).toMatchObject({ status: "resolved" });
    expect(resolved?.resolvedAt).not.toBeNull();
    await drainOutbox(deps);
    expect(setup.github.issues.find((i) => i.number === issue!.number)?.state).toBe("closed");
  });
});
