import picomatch from "picomatch";

// Policy engine (ARCHITECTURE.md §4.4) : fonction pure, sans I/O. Tout ce qui n'est pas
// explicitement autorisé est refusé. Ordre d'évaluation :
//   1. refus absolus ; 2. arrêt d'urgence et gels ; 3. règles du repo ; 4. refus par défaut.

export type Role =
  | "triager"
  | "specifier"
  | "architect"
  | "developer"
  | "reviewer"
  | "security_reviewer"
  | "learner"
  | "devops"
  | "security";

export type Decision = {
  effect: "allow" | "deny" | "require_approval";
  reason: string;
  ruleId: string;
};

/** Outils pièges : ils existent pour que la tentative soit refusée proprement et journalisée (§7). */
export const ALWAYS_DENIED_CAPABILITIES = [
  "merge_pull_request",
  "deploy",
  "read_secret",
  "git_push",
] as const;

/** Outils `jules` de chaque rôle (ARCHITECTURE.md §6 et §7). */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly string[]>> = {
  triager: ["submit_triage", "ask_human"],
  specifier: ["submit_spec", "ask_human"],
  architect: ["submit_design", "ask_human"],
  developer: ["set_plan", "post_update", "run_checks", "submit_build", "ask_human"],
  reviewer: ["submit_review"],
  security_reviewer: ["submit_review"],
  learner: ["propose_lessons"],
  devops: [
    "post_update",
    "set_plan",
    "ask_human",
    "request_task",
    "server_exec",
    "server_run_playbook",
    "submit_change_plan",
    "server_git",
    "server_crontab_read",
    "server_publish_file",
  ],
  security: [
    "post_update",
    "ask_human",
    "request_task",
    "audit_repo",
    "audit_image",
    "audit_server",
    "audit_platform",
    "server_exec",
    "report_finding",
    "propose_remediation",
  ],
};

/** Chemins protégés intégrés : la config d'un repo ne peut jamais en retirer (§13). */
export const BUILTIN_PROTECTED_PATHS = [
  ".github/**",
  ".jules/**",
  ".claude/**",
  "AGENTS.md",
  "CLAUDE.md",
  "CODEOWNERS",
  "**/CODEOWNERS",
  "**/migrations/**",
  "**/Dockerfile*",
  "Dockerfile*",
  "**/docker-compose*",
  "docker-compose*",
  "infra/**",
  "**/*.tf",
  "**/.env*",
  ".env*",
] as const;

/** Chemins qu'un push de Jules ne touche jamais : GitHub les refuse de toute façon (App sans `workflows`). */
export const FORBIDDEN_PATHS = [".github/workflows/**"] as const;

export const AGENT_BRANCH_PREFIX = "jules/";

export type Controls = {
  /** Arrêt d'urgence global, ou propre au repo ou au serveur concerné (§17). */
  readonly stopped: boolean;
};

export type CapabilityRequest = {
  readonly action: "capability";
  readonly role: Role;
  readonly capability: string;
  readonly controls: Controls;
};

export type PushRequest = {
  readonly action: "push";
  readonly branch: string;
  readonly defaultBranch: string;
  readonly force: boolean;
  readonly changedPaths: readonly string[];
  /** Chemins protégés ajoutés par la config du repo, en plus des chemins intégrés. */
  readonly extraProtectedPaths?: readonly string[];
  /** Une gate humaine (H2) a approuvé la modification des chemins protégés de ce diff. */
  readonly protectedPathsApproved: boolean;
  readonly controls: Controls;
};

export type StartRunRequest = {
  readonly action: "start_run";
  readonly role: Role;
  readonly controls: Controls;
};

/** Niveaux d'autonomie DevOps (ARCHITECTURE.md §6.2), par serveur ou par environnement. */
export type ServerLevel = "D0" | "D1" | "D2" | "D3";
export type Environment = "development" | "staging" | "production";
/** Classe d'une commande, donnée par le parseur shell de `packages/devops` (§9). */
export type CommandClass = "read" | "change" | "dangerous";

export type ServerActionRequest = {
  readonly action: "server_action";
  readonly level: ServerLevel;
  readonly environment: Environment;
  readonly kind: "command" | "playbook";
  /** Pour un playbook : la classe la plus haute de ses étapes une fois rendues. */
  readonly commandClass: CommandClass;
  /** `direct` : outil `server_*` de l'agent ; `plan` : étape d'un plan approuvé, exécutée par le worker. */
  readonly via: "direct" | "plan";
  /** Clé d'hôte validée par un admin, et inchangée depuis. */
  readonly hostKeyTrusted: boolean;
  /** Environnement gelé par un admin (§9). */
  readonly frozen: boolean;
  /** Playbook `deploy*` alors qu'un finding critique ou haut est ouvert sur la cible. */
  readonly deployBlocked?: boolean;
  readonly controls: Controls;
};

export type HumanRole = "admin" | "maintainer" | "member" | "viewer";

export type PlanApprovalRequest = {
  readonly action: "approve_plan";
  readonly environment: Environment;
  readonly source: "github" | "web" | "desktop" | "cli";
  /** Rôle effectif : le rôle Jules plafonné par la permission GitHub sur le repo. */
  readonly approverRole: HumanRole;
  /** Passkey présentée au moment de l'action (web ou desktop). */
  readonly stepUp: boolean;
  /** Réglage admin : approbation de la production depuis GitHub (désactivée par défaut, §12). */
  readonly githubProductionApproval: boolean;
  /** Option « quatre yeux » : l'approbateur doit être une autre personne que le demandeur. */
  readonly fourEyes: boolean;
  readonly approverIsRequester: boolean;
  readonly controls: Controls;
};

export type PolicyRequest =
  CapabilityRequest | PushRequest | StartRunRequest | ServerActionRequest | PlanApprovalRequest;

const allow = (ruleId: string, reason: string): Decision => ({ effect: "allow", reason, ruleId });
const deny = (ruleId: string, reason: string): Decision => ({ effect: "deny", reason, ruleId });

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(path, pattern, { dot: true }));
}

function decideCapability(request: CapabilityRequest): Decision {
  if ((ALWAYS_DENIED_CAPABILITIES as readonly string[]).includes(request.capability)) {
    return deny("absolute.honeypot", `l'outil ${request.capability} est toujours refusé`);
  }
  if (request.controls.stopped) {
    return deny("controls.stopped", "arrêt d'urgence actif");
  }
  if (ROLE_CAPABILITIES[request.role].includes(request.capability)) {
    return allow(
      "role.capability",
      `${request.capability} est autorisé pour le rôle ${request.role}`,
    );
  }
  return deny(
    "default.deny",
    `${request.capability} n'est pas autorisé pour le rôle ${request.role}`,
  );
}

function decidePush(request: PushRequest): Decision {
  if (request.branch === request.defaultBranch) {
    return deny("absolute.default_branch", "push vers la branche par défaut interdit");
  }
  if (
    !request.branch.startsWith(AGENT_BRANCH_PREFIX) ||
    request.branch.length === AGENT_BRANCH_PREFIX.length
  ) {
    return deny("absolute.branch_prefix", `Jules ne pousse que sur ${AGENT_BRANCH_PREFIX}*`);
  }
  if (request.force) {
    return deny("absolute.force_push", "force-push interdit");
  }
  const forbidden = request.changedPaths.filter((p) => matchesAny(p, FORBIDDEN_PATHS));
  if (forbidden.length > 0) {
    return deny("absolute.forbidden_path", `chemins interdits modifiés : ${forbidden.join(", ")}`);
  }
  if (request.controls.stopped) {
    return deny("controls.stopped", "arrêt d'urgence actif");
  }
  const protectedPatterns = [...BUILTIN_PROTECTED_PATHS, ...(request.extraProtectedPaths ?? [])];
  const touched = request.changedPaths.filter((p) => matchesAny(p, protectedPatterns));
  if (touched.length > 0 && !request.protectedPathsApproved) {
    return {
      effect: "require_approval",
      reason: `chemins protégés modifiés : ${touched.join(", ")}`,
      ruleId: "repo.protected_paths",
    };
  }
  return allow("push.agent_branch", `push sur ${request.branch} autorisé`);
}

export function decide(request: PolicyRequest): Decision {
  switch (request.action) {
    case "capability":
      return decideCapability(request);
    case "push":
      return decidePush(request);
    case "start_run":
      return request.controls.stopped
        ? deny("controls.stopped", "arrêt d'urgence actif")
        : allow("run.start", `exécution du rôle ${request.role} autorisée`);
    case "server_action":
      return decideServerAction(request);
    case "approve_plan":
      return decidePlanApproval(request);
  }
}

const requireApproval = (ruleId: string, reason: string): Decision => ({
  effect: "require_approval",
  reason,
  ruleId,
});

/**
 * Action sur un serveur (ARCHITECTURE.md §6.2 et §9). `require_approval` veut dire : passe par un plan
 * de changement approuvé. Les commandes `dangerous` sont refusées quel que soit le niveau.
 */
function decideServerAction(r: ServerActionRequest): Decision {
  if (r.controls.stopped) {
    return deny("controls.stopped", "arrêt d'urgence actif");
  }
  if (!r.hostKeyTrusted) {
    return deny("server.host_key", "clé d'hôte non validée ou changée : un admin doit la valider");
  }
  if (r.commandClass === "dangerous") {
    return deny("absolute.dangerous", "commande dangereuse, toujours refusée");
  }
  if (r.kind === "command" && r.commandClass === "read") {
    return allow("server.read", "lecture autorisée dès D0");
  }
  if (r.frozen) {
    return deny("server.frozen", `environnement ${r.environment} gelé`);
  }
  if (r.deployBlocked) {
    return deny("server.deploy_blocked", "finding critique ou haut ouvert sur la cible");
  }
  if (r.level === "D0") {
    return deny("server.level", "D0 : observateur, aucun changement");
  }
  if (r.via === "plan") {
    return allow("server.plan", "étape d'un plan approuvé");
  }
  if (r.environment === "production") {
    return requireApproval("server.production", "production : plan approuvé requis");
  }
  const direct = r.kind === "playbook" ? r.level !== "D1" : r.level === "D3";
  return direct
    ? allow(
        "server.direct",
        `${r.kind === "playbook" ? "playbook" : "commande"} directe en ${r.level}`,
      )
    : requireApproval("server.level", `${r.level} : plan approuvé requis`);
}

/** Approbation d'un plan (HC1, ARCHITECTURE.md §9 et §12). La production exige une passkey. */
function decidePlanApproval(r: PlanApprovalRequest): Decision {
  if (r.controls.stopped) {
    return deny("controls.stopped", "arrêt d'urgence actif");
  }
  if (r.approverRole === "viewer") {
    return deny("approval.role", "un viewer ne peut pas approuver");
  }
  if (r.environment !== "production") {
    return allow("approval.non_production", "approbation hors production");
  }
  if (r.approverRole === "member") {
    return deny("approval.role", "production : maintainer ou admin requis");
  }
  if (r.source === "github") {
    if (!r.githubProductionApproval) {
      return deny(
        "approval.github_production",
        "approbation de la production depuis GitHub désactivée : passe par le web ou le desktop",
      );
    }
  } else if (r.source === "cli" || !r.stepUp) {
    return deny("approval.passkey", "production : passkey exigée au moment de l'approbation");
  }
  if (r.fourEyes && r.approverIsRequester) {
    return deny("approval.four_eyes", "quatre yeux : l'approbateur doit être une autre personne");
  }
  return allow("approval.production", "approbation de la production");
}
