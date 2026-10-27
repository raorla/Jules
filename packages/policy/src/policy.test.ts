import { describe, expect, it } from "vitest";
import {
  ALWAYS_DENIED_CAPABILITIES,
  ROLE_CAPABILITIES,
  decide,
  matchesAny,
  type PlanApprovalRequest,
  type PushRequest,
  type Role,
  type ServerActionRequest,
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

describe("actions sur un serveur (ARCHITECTURE.md §6.2)", () => {
  const server = (overrides: Partial<ServerActionRequest> = {}): ServerActionRequest => ({
    action: "server_action",
    level: "D1",
    environment: "staging",
    kind: "command",
    commandClass: "change",
    via: "direct",
    hostKeyTrusted: true,
    frozen: false,
    controls: running,
    ...overrides,
  });
  const effect = (overrides: Partial<ServerActionRequest>) => decide(server(overrides)).effect;

  it("suit la matrice D0 à D3 hors production", () => {
    const matrix = (["D0", "D1", "D2", "D3"] as const).map((level) => [
      effect({ level, commandClass: "read" }),
      effect({ level, kind: "playbook" }),
      effect({ level }),
    ]);
    expect(matrix).toEqual([
      ["allow", "deny", "deny"],
      ["allow", "require_approval", "require_approval"],
      ["allow", "allow", "require_approval"],
      ["allow", "allow", "allow"],
    ]);
  });

  it("exige un plan approuvé en production, quel que soit le niveau", () => {
    expect(effect({ level: "D3", environment: "production" })).toBe("require_approval");
    expect(effect({ level: "D3", environment: "production", kind: "playbook" })).toBe(
      "require_approval",
    );
    expect(effect({ level: "D3", environment: "production", commandClass: "read" })).toBe("allow");
  });

  it("autorise les étapes d'un plan approuvé, sauf en D0", () => {
    expect(effect({ via: "plan", environment: "production" })).toBe("allow");
    expect(effect({ via: "plan", level: "D0" })).toBe("deny");
  });

  it("refuse toujours une commande dangereuse, même dans un plan approuvé", () => {
    expect(decide(server({ level: "D3", commandClass: "dangerous", via: "plan" }))).toMatchObject({
      effect: "deny",
      ruleId: "absolute.dangerous",
    });
  });

  it("bloque tout sur une clé d'hôte non validée, et sous arrêt d'urgence", () => {
    expect(decide(server({ hostKeyTrusted: false, commandClass: "read" })).ruleId).toBe(
      "server.host_key",
    );
    expect(decide(server({ controls: stopped, commandClass: "read" })).ruleId).toBe(
      "controls.stopped",
    );
  });

  it("refuse les changements sur un environnement gelé et les déploiements bloqués", () => {
    expect(decide(server({ frozen: true, via: "plan" })).ruleId).toBe("server.frozen");
    expect(effect({ frozen: true, commandClass: "read" })).toBe("allow");
    expect(decide(server({ kind: "playbook", deployBlocked: true, level: "D3" })).ruleId).toBe(
      "server.deploy_blocked",
    );
  });
});

describe("approbation d'un plan (HC1)", () => {
  const approval = (overrides: Partial<PlanApprovalRequest> = {}): PlanApprovalRequest => ({
    action: "approve_plan",
    environment: "production",
    source: "web",
    approverRole: "maintainer",
    stepUp: true,
    githubProductionApproval: false,
    fourEyes: false,
    approverIsRequester: false,
    controls: running,
    ...overrides,
  });
  const rule = (overrides: Partial<PlanApprovalRequest>) => decide(approval(overrides)).ruleId;

  it("accepte la production depuis le web avec une passkey", () => {
    expect(decide(approval()).effect).toBe("allow");
  });

  it("refuse la production depuis GitHub tant qu'un admin ne l'a pas activée", () => {
    expect(rule({ source: "github", stepUp: false })).toBe("approval.github_production");
    expect(decide(approval({ source: "github", githubProductionApproval: true })).effect).toBe(
      "allow",
    );
    expect(rule({ source: "github", githubProductionApproval: true, approverRole: "member" })).toBe(
      "approval.role",
    );
  });

  it("exige la passkey sur le web et refuse le CLI en production", () => {
    expect(rule({ stepUp: false })).toBe("approval.passkey");
    expect(rule({ source: "cli" })).toBe("approval.passkey");
  });

  it("applique les quatre yeux quand l'option est active", () => {
    expect(rule({ fourEyes: true, approverIsRequester: true })).toBe("approval.four_eyes");
    expect(decide(approval({ fourEyes: false, approverIsRequester: true })).effect).toBe("allow");
  });

  it("laisse un member approuver hors production, jamais un viewer", () => {
    expect(
      decide(approval({ environment: "staging", approverRole: "member", source: "github" })).effect,
    ).toBe("allow");
    expect(rule({ environment: "staging", approverRole: "viewer" })).toBe("approval.role");
    expect(rule({ controls: stopped })).toBe("controls.stopped");
  });
});
