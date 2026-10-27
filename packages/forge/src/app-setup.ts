// Permissions et événements de la GitHub App (ARCHITECTURE.md §12). Le worker les vérifie au
// démarrage : une App qui aurait la permission `workflows` pourrait laisser l'agent réécrire la CI.

export type AppInfo = {
  readonly slug: string;
  readonly permissions: Readonly<Record<string, string | undefined>>;
  readonly events: readonly string[];
};

export const REQUIRED_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
  deployments: "write",
  security_events: "write",
};

/** Permissions que l'App ne doit jamais avoir, même en lecture. */
export const FORBIDDEN_PERMISSIONS = [
  "workflows",
  "administration",
  "secrets",
  "actions",
  "environments",
  "organization_administration",
  "organization_secrets",
  "members",
] as const;

export const REQUIRED_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_suite",
  "push",
] as const;

const LEVEL: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };
const level = (value: string | undefined) => (value ? (LEVEL[value] ?? 0) : 0);

export type AppSetupReport = { errors: string[]; warnings: string[] };

export function checkAppSetup(app: AppInfo): AppSetupReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of FORBIDDEN_PERMISSIONS) {
    const granted = app.permissions[name];
    if (granted) {
      errors.push(`permission interdite accordée à l'App : ${name}:${granted}`);
    }
  }
  for (const [name, required] of Object.entries(REQUIRED_PERMISSIONS)) {
    const granted = app.permissions[name];
    if (level(granted) < level(required)) {
      warnings.push(
        `permission insuffisante : ${name} est à ${granted ?? "aucun"}, ${required} attendu`,
      );
    }
  }
  for (const [name, granted] of Object.entries(app.permissions)) {
    if (
      granted &&
      !(name in REQUIRED_PERMISSIONS) &&
      !(FORBIDDEN_PERMISSIONS as readonly string[]).includes(name)
    ) {
      warnings.push(`permission inutile : ${name}:${granted}`);
    }
  }
  for (const event of REQUIRED_EVENTS) {
    if (!app.events.includes(event)) {
      warnings.push(`événement non abonné : ${event}`);
    }
  }
  return { errors, warnings };
}
