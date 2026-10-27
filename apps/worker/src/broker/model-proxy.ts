import type { ServerResponse } from "node:http";
import { costUsd, type Usage } from "./pricing.js";
import type { Masker } from "./masking.js";

// Proxy modèle du broker (ARCHITECTURE.md §4.3) : le sandbox appelle `/model/*` avec son jeton
// d'exécution ; le proxy le remplace par la vraie clé, compte les tokens et le coût, masque les
// secrets connus dans les deux sens et coupe quand le budget est atteint.

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
];
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

export type ProxyRequest = {
  method: string;
  /** Chemin après `/model`, par exemple `/v1/messages?beta=true`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | undefined;
};

export type ProxyAccounting = {
  model: string;
  usage: Usage;
  costUsd: number;
  status: number;
  /** Erreur du fournisseur (surcharge, limite, panne réseau) : compte pour `waiting_provider`. */
  providerError: boolean;
};

export type ModelProxyOptions = {
  upstream: string;
  apiKey: string;
  masker: Masker;
  fetchImpl?: typeof fetch;
};

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function addUsage(target: Usage, raw: RawUsage | undefined, outputIsCumulative: boolean): void {
  if (!raw) {
    return;
  }
  target.inputTokens += raw.input_tokens ?? 0;
  target.cacheReadTokens += raw.cache_read_input_tokens ?? 0;
  target.cacheWriteTokens += raw.cache_creation_input_tokens ?? 0;
  if (raw.output_tokens !== undefined) {
    // Dans un flux, message_delta porte le total des tokens de sortie, pas un incrément.
    target.outputTokens = outputIsCumulative
      ? raw.output_tokens
      : target.outputTokens + raw.output_tokens;
  }
}

/** Lit l'usage dans un flux SSE de l'API Messages, événement par événement. */
export class SseUsageParser {
  readonly usage = emptyUsage();
  #buffer = "";

  push(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n\n")) >= 0) {
      const event = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 2);
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) {
        continue;
      }
      try {
        const parsed = JSON.parse(data) as {
          type?: string;
          message?: { usage?: RawUsage };
          usage?: RawUsage;
        };
        if (parsed.type === "message_start") {
          addUsage(this.usage, parsed.message?.usage, true);
        } else if (parsed.type === "message_delta") {
          addUsage(this.usage, { output_tokens: parsed.usage?.output_tokens }, true);
          const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
            parsed.usage ?? {};
          if (input_tokens || cache_read_input_tokens || cache_creation_input_tokens) {
            addUsage(
              this.usage,
              { input_tokens, cache_read_input_tokens, cache_creation_input_tokens },
              true,
            );
          }
        }
      } catch {
        // Événement incomplet ou non JSON : rien à compter.
      }
    }
  }
}

export function isProviderError(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

export function anthropicError(status: number, type: string, message: string) {
  return { status, body: JSON.stringify({ type: "error", error: { type, message } }) };
}

/**
 * Transmet une requête au fournisseur et recopie la réponse dans `res`, en flux. Ne ferme pas `res` :
 * l'appelant enregistre d'abord la comptabilité (tokens, coût, erreur du fournisseur), puis ferme.
 */
export async function forwardToModel(
  options: ModelProxyOptions,
  request: ProxyRequest,
  res: ServerResponse,
): Promise<ProxyAccounting> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let model = "inconnu";
  let body: string | undefined;
  if (request.body && request.body.length > 0) {
    body = options.masker.mask(request.body.toString("utf8"));
    try {
      const parsed = JSON.parse(body) as { model?: unknown };
      if (typeof parsed.model === "string") {
        model = parsed.model;
      }
    } catch {
      // Corps non JSON : transmis tel quel, sans modèle connu.
    }
  }

  const headers: Record<string, string> = { "x-api-key": options.apiKey };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${options.upstream.replace(/\/$/, "")}${request.path}`, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    const error = anthropicError(529, "overloaded_error", "fournisseur de modèle injoignable");
    res.writeHead(error.status, { "content-type": "application/json" }).write(error.body);
    return { model, usage: emptyUsage(), costUsd: 0, status: error.status, providerError: true };
  }

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key)) {
      responseHeaders[key] = value;
    }
  });
  res.writeHead(upstream.status, responseHeaders);

  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const usage = emptyUsage();
  const sse = new SseUsageParser();
  let json = "";
  if (upstream.body) {
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      const text = decoder.decode(chunk as Uint8Array, { stream: true });
      if (isStream) {
        sse.push(text);
      } else {
        json += text;
      }
      res.write(options.masker.mask(text));
    }
  }

  if (isStream) {
    Object.assign(usage, sse.usage);
  } else if (json) {
    try {
      addUsage(usage, (JSON.parse(json) as { usage?: RawUsage }).usage, false);
    } catch {
      // Réponse non JSON (erreur HTML d'un proxy, par exemple) : rien à compter.
    }
  }
  return {
    model,
    usage,
    costUsd: costUsd(model, usage),
    status: upstream.status,
    providerError: isProviderError(upstream.status),
  };
}
