import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";

// Egress proxy (ARCHITECTURE.md §4.9) : le seul chemin vers Internet depuis un sandbox.
// Un proxy par exécution, avec l'allowlist de cette exécution. Tout le reste est refusé et journalisé.
// Lancé seul : `node egress-proxy.js` avec JULES_EGRESS_ALLOW="registry.npmjs.org,*.pythonhosted.org".

export type EgressDecision = { host: string; port: number; allowed: boolean; method: string };

const DEFAULT_PORTS = [80, 443];

export function parseAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** `*.exemple.org` couvre les sous-domaines, pas `exemple.org` lui-même. */
export function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((pattern) =>
    pattern.startsWith("*.")
      ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1
      : h === pattern,
  );
}

/** Refuse les adresses IP littérales : l'allowlist porte sur des noms d'hôte. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function splitHostPort(
  target: string,
  defaultPort: number,
): { host: string; port: number } | undefined {
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target);
  if (!match?.[1]) {
    return undefined;
  }
  return { host: match[1], port: match[2] ? Number(match[2]) : defaultPort };
}

export type EgressProxyOptions = {
  allow: readonly string[];
  /** Ports joignables ; 80 et 443 par défaut. */
  ports?: readonly number[];
  onDecision?: (decision: EgressDecision) => void;
};

export function createEgressProxy(options: EgressProxyOptions): Server {
  const ports = new Set(options.ports ?? DEFAULT_PORTS);
  const check = (host: string, port: number, method: string): boolean => {
    const allowed = !isIpLiteral(host) && ports.has(port) && isHostAllowed(host, options.allow);
    options.onDecision?.({ host, port, allowed, method });
    return allowed;
  };

  const server = createServer((req, res) => {
    // Requête HTTP en clair, forme absolue : GET http://hote/chemin
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("requête de proxy invalide\n");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    if (url.protocol !== "http:" || !check(url.hostname, port, req.method ?? "GET")) {
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end(`Jules : sortie refusée vers ${url.hostname}\n`);
      return;
    }
    const upstream = httpRequest(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end();
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    // Sans ce gestionnaire, un client qui coupe après un refus ferait tomber le proxy entier.
    client.on("error", () => client.destroy());
    const target = splitHostPort(req.url ?? "", 443);
    if (!target || !check(target.host, target.port, "CONNECT")) {
      client.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nJules : sortie refusée vers ${target?.host ?? "?"}\n`,
      );
      return;
    }
    const upstream = connect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", close);
    client.on("error", close);
  });

  return server;
}

// Point d'entrée de l'image egress : journalise chaque décision en JSON sur stdout.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const allow = parseAllowlist(process.env.JULES_EGRESS_ALLOW ?? "");
  const port = Number(process.env.JULES_EGRESS_PORT ?? 3128);
  createEgressProxy({
    allow,
    onDecision: (d) => {
      process.stdout.write(`${JSON.stringify({ ...d, at: new Date().toISOString() })}\n`);
    },
  }).listen(port, "0.0.0.0");
}
