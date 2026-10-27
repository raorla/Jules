import { z } from "zod";

// Détection des demandes adressées à Jules dans les webhooks (WORKFLOW.md §4, phase 1 ; §7).
// Tout le contenu d'une issue est une donnée non fiable : on n'en tire qu'un déclencheur et un texte.

export type TriggerSettings = {
  /** Mention qui déclenche Jules, par exemple `@jules`. */
  readonly mention: string;
  /** Label qui déclenche Jules, par exemple `jules`. */
  readonly label: string;
};

export type TaskTrigger = {
  readonly source: "issue_comment" | "issue_opened" | "issue_labeled";
  /** `@jules devops <demande>` crée une demande pour l'agent DevOps (ARCHITECTURE.md §12). */
  readonly agent?: "developer" | "devops" | "security";
  readonly installationId: number;
  readonly repo: {
    readonly githubId: number;
    readonly owner: string;
    readonly ownerType: string;
    readonly name: string;
    readonly fullName: string;
    readonly private: boolean;
    readonly defaultBranch: string | null;
  };
  readonly issue: { readonly number: number; readonly title: string };
  readonly sender: { readonly githubId: number; readonly login: string };
  readonly request: string;
};

export type TriggerResult = { trigger: TaskTrigger } | { setup: TaskTrigger } | { ignored: string };

/** Sous-commandes réservées qui arrivent avec leur jalon (aucune depuis M8). */
const RESERVED_SUBCOMMANDS = new Set<string>([]);

const account = z.object({ id: z.number(), login: z.string(), type: z.string() });
const repository = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string().optional(),
  owner: account,
});
const issue = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
const base = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository,
  sender: account,
  issue,
});
export const issueCommentPayload = base.extend({
  comment: z.object({ body: z.string(), user: account }),
});
const issuesPayload = base.extend({ label: z.object({ name: z.string() }).optional() });

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Première mention de Jules dans la prose, avec le texte qui la suit. */
export function findMention(
  text: string,
  mention: string,
): { index: number; rest: string } | undefined {
  const cleaned = prose(text);
  const match = new RegExp(`(^|[^\\w@/.-])(${escapeRegExp(mention)})(?![\\w-])`, "i").exec(cleaned);
  if (!match) {
    return undefined;
  }
  const index = match.index + (match[1]?.length ?? 0);
  return { index, rest: cleaned.slice(index + mention.length).trim() };
}

export function detectTrigger(
  event: string,
  payload: unknown,
  settings: TriggerSettings,
): TriggerResult {
  if (event === "issue_comment") {
    const parsed = issueCommentPayload.safeParse(payload);
    if (!parsed.success) {
      return { ignored: "payload_unexpected" };
    }
    const p = parsed.data;
    if (p.action !== "created") {
      // Un commentaire modifié ne déclenche rien : sinon on pourrait réécrire une demande déjà traitée.
      return { ignored: "comment_not_created" };
    }
    if (p.issue.pull_request !== undefined) {
      return { ignored: "pull_request_comment" };
    }
    if (p.sender.type === "Bot" || p.comment.user.type === "Bot") {
      return { ignored: "sender_is_bot" };
    }
    const mention = findMention(p.comment.body, settings.mention);
    if (!mention) {
      return { ignored: "no_mention" };
    }
    const subcommand = mention.rest.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (subcommand === "setup") {
      return { setup: toTrigger(p, "issue_comment", p.comment.body) };
    }
    if (RESERVED_SUBCOMMANDS.has(subcommand)) {
      return { ignored: `subcommand_unavailable:${subcommand}` };
    }
    if (subcommand === "devops" || subcommand === "security") {
      return { trigger: { ...toTrigger(p, "issue_comment", p.comment.body), agent: subcommand } };
    }
    return { trigger: toTrigger(p, "issue_comment", p.comment.body) };
  }

  if (event === "issues") {
    const parsed = issuesPayload.safeParse(payload);
    if (!parsed.success) {
      return { ignored: "payload_unexpected" };
    }
    const p = parsed.data;
    if (p.issue.pull_request !== undefined) {
      return { ignored: "pull_request" };
    }
    if (p.sender.type === "Bot") {
      return { ignored: "sender_is_bot" };
    }
    const body = p.issue.body ?? "";
    if (p.action === "labeled") {
      return p.label?.name.toLowerCase() === settings.label.toLowerCase()
        ? { trigger: toTrigger(p, "issue_labeled", body) }
        : { ignored: "other_label" };
    }
    if (p.action === "opened") {
      return findMention(body, settings.mention)
        ? { trigger: toTrigger(p, "issue_opened", body) }
        : { ignored: "no_mention" };
    }
    return { ignored: "issue_action_not_handled" };
  }

  return { ignored: "event_not_handled" };
}

function toTrigger(
  p: z.infer<typeof base>,
  source: TaskTrigger["source"],
  request: string,
): TaskTrigger {
  return {
    source,
    installationId: p.installation.id,
    repo: {
      githubId: p.repository.id,
      owner: p.repository.owner.login,
      ownerType: p.repository.owner.type,
      name: p.repository.name,
      fullName: p.repository.full_name,
      private: p.repository.private,
      defaultBranch: p.repository.default_branch ?? null,
    },
    issue: { number: p.issue.number, title: p.issue.title },
    sender: { githubId: p.sender.id, login: p.sender.login },
    request,
  };
}
