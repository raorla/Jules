import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Faux fournisseur de modèle : il parle l'API Messages (JSON et SSE) et joue un scénario.
// L'étape du scénario se déduit de la conversation (nombre de réponses déjà données), pas d'un
// compteur : les requêtes annexes de Claude Code et les nouvelles tentatives ne la décalent pas.

export type Step = { text: string } | { tool: string; input: Record<string, unknown> };

export type FakeModel = {
  url: string;
  requests: { path: string; body: Record<string, unknown>; headers: IncomingMessage["headers"] }[];
  /** Les N prochaines requêtes répondent 529 (surcharge). */
  overloadNext(count: number): void;
  /** Les N prochaines requêtes répondent 429 (limite atteinte), avec la reprise annoncée. */
  limitNext(count: number, retryAfterSeconds: number): void;
  /** Usage déclaré pour chaque réponse (pour tester le budget). */
  setUsage(usage: { input_tokens: number; output_tokens: number }): void;
  /** Bloque les réponses jusqu'à `release()` (pour tester l'arrêt d'urgence). */
  hang(): void;
  release(): void;
  close(): Promise<void>;
};

type Body = {
  stream?: boolean;
  model?: string;
  tools?: { name: string }[];
  messages?: { role: string; content: unknown }[];
};

function sse(res: ServerResponse, events: Record<string, unknown>[]) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) {
    res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

/** Un scénario par rôle, reconnu à l'outil de soumission présent dans la requête. */
export type Scripts = Partial<
  Record<"triage" | "spec" | "design" | "build" | "review" | "learn" | "devops", Step[]>
>;
const ROLE_TOOLS = {
  triage: "mcp__jules__submit_triage",
  spec: "mcp__jules__submit_spec",
  design: "mcp__jules__submit_design",
  build: "mcp__jules__submit_build",
  review: "mcp__jules__submit_review",
  learn: "mcp__jules__propose_lessons",
  devops: "mcp__jules__submit_change_plan",
} as const;

/** Scénarios fixes, ou choisis selon la requête (par exemple selon le prompt système reçu). */
export async function startFakeModel(
  input: Step[] | Scripts | ((body: Record<string, unknown>) => Scripts),
): Promise<FakeModel> {
  const pick = (body: Record<string, unknown>): Scripts =>
    typeof input === "function" ? input(body) : Array.isArray(input) ? { build: input } : input;
  const requests: FakeModel["requests"] = [];
  let overloaded = 0;
  let limited = { count: 0, retryAfter: 0 };
  let usage = { input_tokens: 100, output_tokens: 20 };
  let hanging: (() => void)[] | undefined;
  let id = 0;

  const respond = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const path = req.url ?? "/";
    const body = (raw ? JSON.parse(raw) : {}) as Body;
    requests.push({ path, body: body, headers: req.headers });

    if (path.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
      return;
    }
    if (!path.includes("/v1/messages")) {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end('{"type":"error","error":{"type":"not_found_error","message":"inconnu"}}');
      return;
    }
    if (limited.count > 0) {
      limited.count -= 1;
      res
        .writeHead(429, {
          "content-type": "application/json",
          "retry-after": String(limited.retryAfter),
        })
        .end('{"type":"error","error":{"type":"rate_limit_error","message":"limite atteinte"}}');
      return;
    }
    if (overloaded > 0) {
      overloaded -= 1;
      res
        .writeHead(529, { "content-type": "application/json" })
        .end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
      return;
    }

    const tools = new Set((body.tools ?? []).map((t) => t.name));
    const role = (Object.keys(ROLE_TOOLS) as (keyof typeof ROLE_TOOLS)[]).find((r) =>
      tools.has(ROLE_TOOLS[r]),
    );
    const assistantTurns = (body.messages ?? []).filter((m) => m.role === "assistant").length;
    const step: Step = role
      ? (pick(body)[role]?.[assistantTurns] ?? { text: "Terminé." })
      : { text: "ok" };
    const messageId = `msg_${++id}`;
    const block =
      "tool" in step
        ? { type: "tool_use", id: `toolu_${id}`, name: step.tool, input: {} }
        : { type: "text", text: "" };
    const delta =
      "tool" in step
        ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) }
        : { type: "text_delta", text: step.text };
    const stopReason = "tool" in step ? "tool_use" : "end_turn";
    const model = body.model ?? "claude-opus-5-5";

    if (body.stream) {
      sse(res, [
        {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_delta", index: 0, delta },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        },
        { type: "message_stop" },
      ]);
    } else {
      const content =
        "tool" in step ? [{ ...block, input: step.input }] : [{ type: "text", text: step.text }];
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        }),
      );
    }
  };

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      if (hanging) {
        hanging.push(() => {
          respond(req, res, raw);
        });
      } else {
        respond(req, res, raw);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    overloadNext: (count) => {
      overloaded = count;
    },
    limitNext: (count, retryAfter) => {
      limited = { count, retryAfter };
    },
    setUsage: (u) => {
      usage = u;
    },
    hang: () => {
      hanging = [];
    },
    release: () => {
      const pending = hanging ?? [];
      hanging = undefined;
      pending.forEach((fn) => {
        fn();
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
