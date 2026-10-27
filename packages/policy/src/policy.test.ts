import { describe, expect, it } from "vitest";
import {
  ALWAYS_DENIED_CAPABILITIES,
  ROLE_CAPABILITIES,
  decide,
  matchesAny,
  type PushRequest,
  type Role,
} from "./policy.js";

const running = { stopped: false };
const stopped = { stopped: true };
const roles = Object.keys(ROLE_CAPABILITIES) as Role[];

describe("capabilities", () => {
  it.each(roles.flatMap((role) => ALWAYS_DENIED_CAPABILITIES.map((c) => [role, c] as const)))(
    "%s ne peut jamais appeler %s",
    (role, capability) => {
      expect(decide({ action: "capability", role, capability, controls: running })).toMatchObject({
        effect: "deny",
        ruleId: "absolute.honeypot",
      });
    },
  );

  it.each(roles.flatMap((role) => ROLE_CAPABILITIES[role].map((c) => [role, c] as const)))(
    "%s peut appeler %s",
    (role, capability) => {
      expect(decide({ action: "capability", role, capability, controls: running })).toEqual({
        effect: "allow",
        ruleId: "role.capability",
        reason: `${capability} est autorisé pour le rôle ${role}`,
      });
    },
  );

  it("refuse un outil d'un autre rôle ou inconnu", () => {
    expect(
      decide({
        action: "capability",
        role: "reviewer",
        capability: "submit_build",
        controls: running,
      }),
    ).toMatchObject({
      effect: "deny",
      ruleId: "default.deny",
    });
    expect(
      decide({ action: "capability", role: "developer", capability: "rm_rf", controls: running })
        .effect,
    ).toBe("deny");
  });

  it("refuse tout pendant l'arrêt d'urgence, mais garde le refus absolu en premier", () => {
    expect(
      decide({
        action: "capability",
        role: "developer",
        capability: "post_update",
        controls: stopped,
      }),
    ).toMatchObject({
      ruleId: "controls.stopped",
    });
    expect(
      decide({
        action: "capability",
        role: "developer",
        capability: "git_push",
        controls: stopped,
      }),
    ).toMatchObject({
      ruleId: "absolute.honeypot",
    });
  });
});

describe("push", () => {
  const push = (overrides: Partial<PushRequest>): PushRequest => ({
    action: "push",
    branch: "jules/12-healthz",
    defaultBranch: "main",
    force: false,
    changedPaths: ["src/health.ts"],
    protectedPathsApproved: false,
    controls: running,
    ...overrides,
  });

  it("autorise un push normal sur jules/*", () => {
    expect(decide(push({}))).toMatchObject({ effect: "allow", ruleId: "push.agent_branch" });
  });

  it.each([
    ["la branche par défaut", { branch: "main" }, "absolute.default_branch"],
    ["une branche hors jules/*", { branch: "feature/x" }, "absolute.branch_prefix"],
    ["le préfixe seul", { branch: "jules/" }, "absolute.branch_prefix"],
    ["un force-push", { force: true }, "absolute.force_push"],
    [
      "un workflow de CI",
      { changedPaths: ["src/a.ts", ".github/workflows/ci.yml"] },
      "absolute.forbidden_path",
    ],
    ["pendant l'arrêt d'urgence", { controls: stopped }, "controls.stopped"],
  ])("refuse %s", (_, overrides, ruleId) => {
    expect(decide(push(overrides))).toMatchObject({ effect: "deny", ruleId });
  });

  it("refuse un workflow même si les chemins protégés sont approuvés", () => {
    expect(
      decide(push({ changedPaths: [".github/workflows/ci.yml"], protectedPathsApproved: true }))
        .effect,
    ).toBe("deny");
  });

  it.each([
    ".jules/config.yml",
    "AGENTS.md",
    "db/migrations/0001.sql",
    "Dockerfile",
    "deploy/Dockerfile.prod",
    ".env.local",
    "infra/main.tf",
    ".github/CODEOWNERS",
  ])("demande une approbation pour le chemin protégé %s", (path) => {
    expect(decide(push({ changedPaths: [path] }))).toMatchObject({
      effect: "require_approval",
      ruleId: "repo.protected_paths",
    });
  });

  it("accepte un chemin protégé approuvé et applique les chemins ajoutés par le repo", () => {
    expect(decide(push({ changedPaths: ["AGENTS.md"], protectedPathsApproved: true })).effect).toBe(
      "allow",
    );
    expect(
      decide(push({ changedPaths: ["src/auth/login.ts"], extraProtectedPaths: ["src/auth/**"] }))
        .effect,
    ).toBe("require_approval");
  });
});

describe("start_run", () => {
  it("refuse de démarrer pendant l'arrêt d'urgence", () => {
    expect(decide({ action: "start_run", role: "developer", controls: running }).effect).toBe(
      "allow",
    );
    expect(decide({ action: "start_run", role: "developer", controls: stopped })).toMatchObject({
      effect: "deny",
      ruleId: "controls.stopped",
    });
  });
});

describe("matchesAny", () => {
  it("couvre les fichiers cachés", () => {
    expect(matchesAny(".env", [".env*"])).toBe(true);
    expect(matchesAny("src/a.ts", [".env*"])).toBe(false);
  });
});
