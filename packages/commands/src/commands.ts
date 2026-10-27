import type { Risk } from "@jules/workflow";

// Commandes humaines (WORKFLOW.md §7), communes à GitHub, au web et au desktop. Ce module dit
// quelle commande est demandée et quel droit elle exige ; l'orchestrateur l'applique.

export type RepoRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export type Command =
  | { name: "approve" }
  | { name: "revise"; feedback: string }
  | { name: "retry" }
  | { name: "budget"; addUsd: number }
  | { name: "pause" }
  | { name: "resume" }
  | { name: "cancel" }
  | { name: "fix"; instructions: string }
  | { name: "stop_all" }
  | { name: "lesson"; decision: "approve" | "reject"; lessonId: string };

export type ParsedCommand = { command: Command } | { error: string };

const ROLE_ORDER: readonly RepoRole[] = ["admin", "maintain", "write", "triage", "read", "none"];

export function hasRole(role: RepoRole, required: RepoRole): boolean {
  return ROLE_ORDER.indexOf(role) <= ROLE_ORDER.indexOf(required);
}

/** Retire ce qui n'est pas du texte adressé à Jules : code, citations, commentaires HTML. */
export function prose(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** Première ligne `/jules …` du texte, hors code et citations. `undefined` s'il n'y en a pas. */
export function parseCommand(body: string): ParsedCommand | undefined {
  const line = prose(body)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^\/jules(\s|$)/i.test(l));
  if (line === undefined) {
    return undefined;
  }
  const [, verb = "", ...rest] = line.split(/\s+/);
  const args = rest.join(" ").trim();
  switch (verb.toLowerCase()) {
    case "approve":
      return { command: { name: "approve" } };
    case "revise":
      return args
        ? { command: { name: "revise", feedback: args.slice(0, 4000) } }
        : { error: "`/jules revise` attend un retour : `/jules revise <ce qui ne va pas>`" };
    case "fix":
      return args
        ? { command: { name: "fix", instructions: args.slice(0, 4000) } }
        : { error: "`/jules fix` attend des instructions" };
    case "retry":
      return { command: { name: "retry" } };
    case "pause":
      return { command: { name: "pause" } };
    case "resume":
      return { command: { name: "resume" } };
    case "cancel":
      return { command: { name: "cancel" } };
    case "stop-all":
      return { command: { name: "stop_all" } };
    case "lesson": {
      const match = /^(approve|reject)\s+([0-9a-f]{8}(?:-[0-9a-f-]{27})?)$/i.exec(args);
      if (!match) {
        return { error: "`/jules lesson` attend `approve <id>` ou `reject <id>`" };
      }
      const decision = (match[1] as string).toLowerCase() as "approve" | "reject";
      return {
        command: { name: "lesson", decision, lessonId: (match[2] as string).toLowerCase() },
      };
    }
    case "budget": {
      const match = /^\+(\d+(?:\.\d+)?)\$?$/.exec(args);
      const amount = match ? Number(match[1]) : Number.NaN;
      return amount > 0 && amount <= 1000
        ? { command: { name: "budget", addUsd: amount } }
        : { error: "`/jules budget` attend un montant positif : `/jules budget +10`" };
    }
    default:
      return { error: `commande inconnue : \`/jules ${verb}\`` };
  }
}

/** Droit GitHub exigé (WORKFLOW.md §7). Approuver une tâche à risque `high` demande `maintain`. */
export function requiredRole(command: Command, risk: Risk | undefined): RepoRole {
  switch (command.name) {
    case "stop_all":
      return "admin";
    case "budget":
    case "lesson":
      return "maintain";
    case "approve":
      return risk === "high" ? "maintain" : "write";
    default:
      return "write";
  }
}

export function authorize(
  command: Command,
  role: RepoRole,
  risk: Risk | undefined,
): { ok: true } | { ok: false; reason: string } {
  const required = requiredRole(command, risk);
  return hasRole(role, required)
    ? { ok: true }
    : {
        ok: false,
        reason: `\`/jules ${command.name.replace("_", "-")}\` demande le droit ${required} (tu as ${role})`,
      };
}
