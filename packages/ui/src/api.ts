import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

// Client de l'api `/v1`, partagé par le web et le desktop. Les écritures portent le jeton CSRF de la
// session ; une action sensible renvoie `stepUp: true` et l'interface demande alors la passkey.

export type Me = {
  userId: string;
  login: string;
  role: "admin" | "maintainer" | "member" | "viewer";
  csrfToken: string;
  stepUpUntil: string | null;
};
export type TaskState =
  | "received"
  | "triaging"
  | "awaiting_info"
  | "specifying"
  | "awaiting_spec_approval"
  | "designing"
  | "awaiting_design_approval"
  | "building"
  | "verifying"
  | "reviewing"
  | "awaiting_human_review"
  | "learning"
  | "diagnosing"
  | "awaiting_plan_approval"
  | "executing"
  | "auditing"
  | "done"
  | "waiting_provider"
  | "blocked"
  | "cancelled"
  | "failed";
export type TaskSummary = {
  agent?: "developer" | "devops" | "security";
  id: string;
  repo: string;
  title: string;
  state: TaskState;
  type: string | null;
  size: string | null;
  risk: "low" | "medium" | "high" | null;
  autonomy: string | null;
  issueNumber: number | null;
  prUrl: string | null;
  costUsd: number;
  budgetUsd: number | null;
  lastError: string | null;
  updatedAt: string;
};
export type Artifact = {
  kind: string;
  version: number;
  content: unknown;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
};
export type TaskDetail = {
  task: TaskSummary & {
    request: string;
    branch: string | null;
    iterations: number;
    reviewRounds: number;
    version: number;
  };
  artifacts: Artifact[];
  runs: {
    id: string;
    role: string;
    model: string;
    promptVersion: string;
    status: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    startedAt: string | null;
    endedAt: string | null;
  }[];
  commands: {
    id: string;
    name: string;
    source: string;
    decision: string;
    reason: string;
    createdAt: string;
    login: string | null;
  }[];
  timeline: { at: string; action: string; data: { from?: string; to?: string; reason?: string } }[];
};
export type Repo = {
  id: string;
  fullName: string;
  autonomy: "L0" | "L1" | "L2";
  private: boolean;
  defaultBranch: string | null;
};
export type Metrics = {
  repo: string;
  autonomy: string | null;
  tasks: number;
  prsOpened: number;
  merged: number;
  acceptanceRate: number | null;
  firstTryGateRate: number | null;
  costPerMergedPr: number | null;
  avgHoursToReady: number | null;
  totalCostUsd: number;
  promotion: string | null;
};
export type AuditRow = {
  seq: number;
  at: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: unknown;
};
export type Environment = "development" | "staging" | "production";
export type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  environment: Environment;
  level: "D0" | "D1" | "D2" | "D3";
  repo: string | null;
  repoId: string | null;
  hostKeyStatus: "pending" | "awaiting_validation" | "trusted" | "changed" | "unreachable";
  hostKeyFingerprint: string | null;
  offeredFingerprint: string | null;
  offeredAlgorithm: string | null;
  frozen: boolean;
  locked: boolean;
  createdAt: string;
};
export type ServerCommand = {
  id: string;
  command: string;
  commandClass: "read" | "change" | "dangerous";
  decision: "allow" | "deny" | "require_approval";
  ruleId: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  output: string | null;
  source: string;
  createdAt: string;
};
export type PlanAction =
  | { kind: "command"; command: string; reason: string }
  | { kind: "playbook"; name: string; params: Record<string, string> };
export type ChangePlan = {
  goal: string;
  server: string;
  environment: Environment;
  actions: PlanAction[];
  impact: string;
  verify: string[];
  rollback: string[];
};
export type Plan = {
  id: string;
  taskId: string | null;
  deploymentId: string | null;
  server: string;
  environment: Environment;
  status: string;
  plan: ChangePlan;
  approvalSource: string | null;
  failureReason: string | null;
  expiresAt: string;
  createdAt: string;
};
export type Deployment = {
  id: string;
  repo: string;
  server: string;
  environment: Environment;
  ref: string;
  previousRef: string | null;
  status: string;
  playbook: string;
  planId: string | null;
  pullRequests: number[];
  reason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};
export type Dora = {
  days: number;
  deploymentsPerWeek: number;
  leadTimeHours: number | null;
  changeFailureRate: number | null;
  timeToRestoreHours: number | null;
  approvalsPerDay: number;
};
export type Severity = "critical" | "high" | "medium" | "low";
export type Finding = {
  id: string;
  scope: "repo" | "server" | "platform" | "image";
  target: string;
  targetId: string;
  category: string;
  component: string;
  title: string;
  severity: Severity;
  status: "open" | "triaged" | "in_remediation" | "resolved" | "accepted_risk" | "false_positive";
  scanner: string;
  evidence: string;
  analysis: string | null;
  falsePositiveSuggested: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  dueAt: string | null;
  acceptedUntil: string | null;
  reopenCount: number;
  remediationTaskId: string | null;
};
export type SecurityMetrics = {
  openBySeverity: Record<Severity, number>;
  openByScope: Record<string, number>;
  overdueShare: number | null;
  meanDaysToFix: Record<Severity, number | null>;
  reopened: number;
  falsePositiveRate: Record<string, number>;
};
export type AuditSummary = {
  id: string;
  scope: string;
  target: string;
  trigger: string;
  status: string;
  summary: { created?: number; resolved?: number; active?: number };
  error: string | null;
  createdAt: string;
};
export type OrgSettings = {
  fourEyes: boolean;
  githubProductionApproval: boolean;
  securityLevel: "S0" | "S1";
};
export type Command =
  | { name: "approve" | "retry" | "cancel" | "pause" | "resume" | "stop_all" }
  | { name: "revise"; feedback: string }
  | { name: "fix"; instructions: string }
  | { name: "budget"; addUsd: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly stepUp = false,
  ) {
    super(message);
  }
}

let csrf: string | undefined;
let base = "";
let bearer: string | undefined;

/**
 * Le web reste sur la même origine, avec le cookie de session et le jeton CSRF. Le desktop pointe
 * vers son serveur avec un jeton porteur (`jds_…`, rangé dans le trousseau) : ni cookie ni CSRF.
 */
export function configureApi(options: { baseUrl?: string; token?: string }) {
  base = options.baseUrl ?? "";
  bearer = options.token;
  csrf = undefined;
}

export async function api<T>(
  path: string,
  /** `anonymous` : appel sans session (échange du code du desktop), donc sans jeton CSRF. */
  init: { method?: string; body?: unknown; anonymous?: boolean } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  } else if (method !== "GET" && !init.anonymous) {
    csrf ??= (await api<Me>("/v1/me")).csrfToken;
    headers["x-jules-csrf"] = csrf;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    credentials: bearer ? "omit" : "same-origin",
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  const data = (text ? JSON.parse(text) : {}) as { error?: string; stepUp?: boolean };
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? response.statusText, data.stepUp === true);
  }
  return data as T;
}

export const sendCommand = (taskId: string, command: Command) =>
  api<{ commandId: string }>(`/v1/tasks/${taskId}/commands`, { method: "POST", body: command });

export async function registerPasskey(label: string): Promise<void> {
  const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/v1/passkeys/register/options",
    { method: "POST", body: {} },
  );
  const response = await startRegistration({ optionsJSON: options });
  await api("/v1/passkeys/register/verify", { method: "POST", body: { response, label } });
}

/** Authentification renforcée : la passkey est demandée au moment même de l'action sensible. */
export async function stepUp(purpose: string): Promise<void> {
  const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/v1/step-up/options",
    { method: "POST", body: { purpose } },
  );
  const response = await startAuthentication({ optionsJSON: options });
  await api("/v1/step-up/verify", { method: "POST", body: { response } });
}

/** Lit un flux SSE par fetch : seule façon d'envoyer le jeton porteur du desktop. */
async function readEvents(
  url: string,
  token: string,
  signal: AbortSignal,
  onTask: (data: string) => void,
) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    signal,
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) {
      return;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = /^data: (.*)$/m.exec(event)?.[1];
      if (/^event: task$/m.test(event) && data) {
        onTask(data);
      }
    }
  }
}

/** Temps réel : chaque changement de tâche annoncé par l'api rafraîchit ce qui est affiché. */
export function useLiveUpdates(): void {
  const client = useQueryClient();
  useEffect(() => {
    const onTask = (raw: string) => {
      const { id } = JSON.parse(raw) as { id: string };
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["task", id] });
      void client.invalidateQueries({ queryKey: ["approvals"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void client.invalidateQueries({ queryKey: ["deployments"] });
      void client.invalidateQueries({ queryKey: ["servers"] });
      void client.invalidateQueries({ queryKey: ["findings"] });
    };
    if (bearer) {
      const controller = new AbortController();
      const token = bearer;
      // Reconnexion simple : le flux se rouvre tant que la fenêtre vit.
      const loop = async () => {
        while (!controller.signal.aborted) {
          await readEvents(`${base}/v1/events`, token, controller.signal, onTask).catch(
            () => undefined,
          );
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      };
      void loop();
      return () => {
        controller.abort();
      };
    }
    const source = new EventSource(`${base}/v1/events`, { withCredentials: true });
    const listener = (event: MessageEvent<string>) => {
      onTask(event.data);
    };
    source.addEventListener("task", listener);
    return () => {
      source.removeEventListener("task", listener);
      source.close();
    };
  }, [client]);
}
