import { appendAudit } from "@jules/audit";
import { tasks, eq, type Tx } from "@jules/db";
import {
  classify,
  classifyPlaybook,
  expandPlan,
  renderPlaybook,
  type ChangePlan,
  type CommandClass,
  type Playbook,
} from "@jules/devops";
import { decide, type Decision } from "@jules/policy";
import type { CommandResult } from "@jules/ssh";
import type { PlanService } from "../devops/plans.js";
import { hostKeyTrusted, type ServerRow, type ServerService } from "../devops/servers.js";

// Outils `server_*` de l'agent DevOps (ARCHITECTURE.md §7). La décision (classe de la commande,
// niveau D, environnement, clé d'hôte, gel) est prise dans la transaction de l'appel ; la commande
// SSH part ensuite, hors transaction, pour ne bloquer ni l'audit ni la base pendant son exécution.

export type DevopsTools = {
  servers: ServerService;
  plans: PlanService;
  /** Playbooks de `.jules/playbooks.yml`, lus sur la branche par défaut au début de l'exécution. */
  playbooks: Readonly<Record<string, Playbook>>;
};

export type ToolResult = {
  text: string;
  status?: number;
  /** Travail à faire une fois la transaction validée ; son texte remplace `text`. */
  after?: () => Promise<string>;
};

export type ToolContext = {
  orgId: string;
  runId: string;
  taskId: string;
  stopped: boolean;
  devops?: DevopsTools;
};

const unavailable: ToolResult = {
  status: 503,
  text: "Outils serveur indisponibles dans cette exécution.",
};

async function findServer(
  tx: Tx,
  ctx: ToolContext,
  tools: DevopsTools,
  name: string,
): Promise<ServerRow | ToolResult> {
  const server = await tools.servers.byName(tx, ctx.orgId, name);
  return (
    server ?? {
      status: 404,
      text: `Serveur inconnu : « ${name} ». Utilise un nom de la liste fournie.`,
    }
  );
}

function format(server: ServerRow, result: CommandResult): string {
  const header = [
    `ok: ${server.name}`,
    `code ${result.exitCode ?? "aucun"}`,
    `${result.durationMs} ms`,
    ...(result.timedOut ? ["délai dépassé"] : []),
  ].join(" · ");
  return `${header}\n${result.truncated ? "[début de la sortie tronqué]\n" : ""}${result.output}`;
}

async function refuse(
  tx: Tx,
  ctx: ToolContext,
  tools: DevopsTools,
  server: ServerRow,
  command: string,
  commandClass: CommandClass,
  decision: Decision,
  reasons: readonly string[],
): Promise<ToolResult> {
  await tools.servers.recordRefusal(tx, server, command, {
    source: "agent",
    runId: ctx.runId,
    commandClass,
    decision,
  });
  await appendAudit(tx, {
    orgId: ctx.orgId,
    actor: { type: "agent", id: ctx.runId },
    action: "server.command.refused",
    target: { type: "server", id: server.id },
    data: { class: commandClass, ruleId: decision.ruleId },
  });
  return {
    status: 403,
    text:
      decision.effect === "require_approval"
        ? `Refusé : ${decision.reason}. Cette commande (${commandClass}) n'est pas permise directement : mets-la telle quelle dans un plan avec submit_change_plan. Un plan approuvé n'autorise que ses actions exactes.`
        : `Refusé par la politique du projet : ${decision.reason}${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}. Ne réessaie pas.`,
  };
}

async function runOnServer(
  tx: Tx,
  ctx: ToolContext,
  tools: DevopsTools,
  server: ServerRow,
  command: string,
  forcedClass?: CommandClass,
): Promise<ToolResult> {
  const classification = classify(command);
  const commandClass = forcedClass ?? classification.class;
  const decision = decide({
    action: "server_action",
    level: server.level,
    environment: server.environment,
    kind: "command",
    commandClass,
    via: "direct",
    hostKeyTrusted: hostKeyTrusted(server),
    frozen: server.frozen,
    controls: { stopped: ctx.stopped },
  });
  if (decision.effect !== "allow") {
    return refuse(tx, ctx, tools, server, command, commandClass, decision, classification.reasons);
  }
  return {
    text: "",
    after: async () => {
      try {
        const result = await tools.servers.execute(server, command, {
          source: "agent",
          runId: ctx.runId,
          commandClass,
          decision,
        });
        return format(server, result);
      } catch (error) {
        return `Échec sur ${server.name} : ${(error as Error).message}`;
      }
    },
  };
}

export async function serverExec(
  tx: Tx,
  ctx: ToolContext,
  input: { server: string; command: string },
): Promise<ToolResult> {
  const tools = ctx.devops;
  if (!tools) {
    return unavailable;
  }
  const server = await findServer(tx, ctx, tools, input.server);
  return "text" in server ? server : runOnServer(tx, ctx, tools, server, input.command);
}

export async function serverCrontabRead(
  tx: Tx,
  ctx: ToolContext,
  input: { server: string },
): Promise<ToolResult> {
  return serverExec(tx, ctx, { server: input.server, command: "crontab -l" });
}

/** Commande git construite par Jules (chemin et URL validés) : hooks désactivés, fast-forward seul. */
export async function serverGit(
  tx: Tx,
  ctx: ToolContext,
  input: {
    server: string;
    operation: "pull" | "fetch" | "clone";
    path: string;
    url?: string | undefined;
  },
): Promise<ToolResult> {
  const tools = ctx.devops;
  if (!tools) {
    return unavailable;
  }
  const server = await findServer(tx, ctx, tools, input.server);
  if ("text" in server) {
    return server;
  }
  const git = "git -c core.hooksPath=/dev/null";
  if (input.operation === "clone" && !input.url) {
    return { status: 400, text: "`clone` exige une url https." };
  }
  const command =
    input.operation === "fetch"
      ? `${git} -C ${input.path} fetch --prune`
      : input.operation === "pull"
        ? `${git} -C ${input.path} pull --ff-only`
        : `${git} clone ${input.url ?? ""} ${input.path}`;
  return runOnServer(
    tx,
    ctx,
    tools,
    server,
    command,
    input.operation === "fetch" ? "read" : "change",
  );
}

/** Dépliage, GC1 et HC1 communs à un plan soumis et à un playbook lancé directement. */
function decideSteps(
  ctx: ToolContext,
  server: ServerRow,
  steps: ReturnType<typeof expandPlan> & { ok: true },
): Decision[] {
  return steps.steps
    .filter((s) => s.phase === "action")
    .map((step) => {
      const { command, playbook } = step;
      return decide({
        action: "server_action",
        level: server.level,
        environment: server.environment,
        kind: playbook ? "playbook" : "command",
        commandClass: classify(command, { inPlaybook: playbook !== undefined }).class,
        via: "direct",
        hostKeyTrusted: hostKeyTrusted(server),
        frozen: server.frozen,
        controls: { stopped: ctx.stopped },
      });
    });
}

async function requester(tx: Tx, taskId: string): Promise<string | null> {
  const [task] = await tx
    .select({ createdBy: tasks.createdBy })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return task?.createdBy ?? null;
}

export async function submitChangePlan(
  tx: Tx,
  ctx: ToolContext,
  input: ChangePlan,
  store: (content: object) => Promise<number>,
): Promise<ToolResult> {
  const tools = ctx.devops;
  if (!tools) {
    return unavailable;
  }
  const server = await findServer(tx, ctx, tools, input.server);
  if ("text" in server) {
    return server;
  }
  const expanded = expandPlan(input, {
    serverEnvironment: server.environment,
    playbooks: tools.playbooks,
  });
  if (!expanded.ok) {
    return {
      status: 400,
      text: `Gate GC1 non satisfaite, corrige le plan et soumets-le à nouveau : ${expanded.problems.join(" ; ")}`,
    };
  }
  const decisions = decideSteps(ctx, server, expanded);
  const denied = decisions.find((d) => d.effect === "deny");
  if (denied) {
    return {
      status: 403,
      text: `Plan refusé par la politique du projet : ${denied.reason}. Ne réessaie pas.`,
    };
  }
  const approvalRequired = decisions.some((d) => d.effect === "require_approval");
  const plan = await tools.plans.submit(tx, {
    server,
    plan: input,
    steps: expanded.steps,
    approvalRequired,
    taskId: ctx.taskId,
    runId: ctx.runId,
    requestedBy: await requester(tx, ctx.taskId),
  });
  const version = await store({ planId: plan.id, approvalRequired, ...input });
  return {
    text: `ok: plan v${version} (${plan.id.slice(0, 8)}) soumis sur ${server.name} (${server.environment}) : ${approvalRequired ? "approbation humaine requise" : "exécution directe à ce niveau"}. Termine maintenant l'exécution ; le worker exécutera le plan.`,
  };
}

export async function serverRunPlaybook(
  tx: Tx,
  ctx: ToolContext,
  input: { server: string; name: string; params: Record<string, string> },
): Promise<ToolResult> {
  const tools = ctx.devops;
  if (!tools) {
    return unavailable;
  }
  const server = await findServer(tx, ctx, tools, input.server);
  if ("text" in server) {
    return server;
  }
  const playbook = tools.playbooks[input.name];
  if (!playbook) {
    return { status: 404, text: `Playbook inconnu : « ${input.name} ».` };
  }
  const rendered = renderPlaybook(input.name, playbook, input.params);
  if (!rendered.ok) {
    return { status: 400, text: `Paramètres invalides : ${rendered.errors.join(" ; ")}` };
  }
  const decision = decide({
    action: "server_action",
    level: server.level,
    environment: server.environment,
    kind: "playbook",
    commandClass: classifyPlaybook(rendered.value).class,
    via: "direct",
    hostKeyTrusted: hostKeyTrusted(server),
    frozen: server.frozen,
    controls: { stopped: ctx.stopped },
  });
  if (decision.effect !== "allow") {
    return refuse(tx, ctx, tools, server, `playbook ${input.name}`, "change", decision, []);
  }
  const plan: ChangePlan = {
    goal: `Playbook ${input.name}`,
    server: server.name,
    environment: server.environment,
    actions: [{ kind: "playbook", name: input.name, params: input.params }],
    impact: playbook.description ?? `playbook ${input.name}`,
    verify: [],
    rollback: [],
  };
  const expanded = expandPlan(plan, {
    serverEnvironment: server.environment,
    playbooks: tools.playbooks,
  });
  if (!expanded.ok) {
    return { status: 400, text: expanded.problems.join(" ; ") };
  }
  const row = await tools.plans.submit(tx, {
    server,
    plan,
    steps: expanded.steps,
    approvalRequired: false,
    taskId: ctx.taskId,
    runId: ctx.runId,
  });
  return {
    text: "",
    after: async () => {
      const outcome = await tools.plans.runOne(row.id);
      return `Playbook ${input.name} sur ${server.name} : ${outcome}`;
    },
  };
}

export function serverPublishFile(): ToolResult {
  return {
    status: 501,
    text: "server_publish_file n'est pas encore disponible : résume le contenu utile dans ton rapport.",
  };
}
