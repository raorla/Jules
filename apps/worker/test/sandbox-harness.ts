import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@jules/db";
import { FakeGitHub } from "@jules/forge/testing";
import { SandboxDriver, type RunOutcome, type RunSpec } from "@jules/sandbox";
import pino from "pino";
import { Masker } from "../src/broker/masking.js";
import { Orchestrator, type OrchestratorDeps } from "../src/orchestrator.js";
import type { FakeModel } from "./fake-model.js";
import { TEST_IMAGES } from "./images.js";

export const API_KEY = "sk-ant-api03-cle-reelle-du-worker-0123456789abcdef";
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Driver qui garde la spec de chaque exécution, pour inspecter ce que reçoit le sandbox. */
export class RecordingDriver extends SandboxDriver {
  readonly specs: RunSpec[] = [];
  override run(spec: RunSpec): Promise<RunOutcome> {
    this.specs.push(spec);
    return super.run(spec);
  }
}

/** Dépôt nu local qui joue le rôle du repo GitHub, avec un commit sur main. */
export function bareRemote(): string {
  const root = mkdtempSync(join(tmpdir(), "jules-remote-"));
  const remote = join(root, "sandbox.git");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  writeFileSync(join(seed, "README.md"), "# sandbox\n");
  writeFileSync(
    join(seed, "package.json"),
    '{ "name": "sandbox", "version": "1.0.0", "private": true }\n',
  );
  execFileSync("git", ["-C", seed, "add", "."]);
  execFileSync("git", [
    "-C",
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "-m",
    "init",
  ]);
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);
  return remote;
}

export function sandboxSetup(
  db: Db,
  model: FakeModel,
  overrides: Partial<OrchestratorDeps["config"]> = {},
) {
  const github = new FakeGitHub({ url: "http://127.0.0.1:9", secret: "x" });
  github.setRole("alice", "write");
  const remote = bareRemote();
  github.remotes.set("acme/sandbox", remote);
  const driver = new RecordingDriver({
    runtime: process.env.JULES_SANDBOX_RUNTIME ?? "runc",
    egressImage: TEST_IMAGES.egress,
  });
  const runsDir = mkdtempSync(join(tmpdir(), "jules-runs-"));
  const log = pino({ level: process.env.JULES_TEST_LOG ?? "silent" });
  const orchestrator = new Orchestrator({
    db,
    github,
    driver,
    log,
    masker: new Masker([API_KEY]),
    config: {
      runsDir,
      promptsDir: join(ROOT, "prompts"),
      sandboxImage: TEST_IMAGES.sandbox,
      egressAllow: ["registry.npmjs.org"],
      language: "fr",
      model: { upstream: model.url, apiKey: API_KEY },
      developer: {
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 20,
        budgetUsd: 5,
        timeoutMs: 180_000,
      },
      maxConcurrentRuns: 2,
      providerRetryBaseMs: 300,
      maxAttempts: 3,
      ...overrides,
    },
  });
  return { github, remote, driver, runsDir, orchestrator, log };
}
