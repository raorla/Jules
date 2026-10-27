import { request } from "node:http";
import { createServer, connect, type Server } from "node:net";

// Le broker est joint par un socket Unix monté dans le sandbox : aucune route réseau vers le worker.

export type CapabilityResponse = { status: number; text: string };

export function callCapability(
  socketPath: string,
  token: string,
  name: string,
  input: unknown,
  timeoutMs = 60_000,
): Promise<CapabilityResponse> {
  const body = JSON.stringify(input ?? {});
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `/capabilities/${encodeURIComponent(name)}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai du broker dépassé")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Relais TCP local → socket Unix, pour les clients qui ne savent parler qu'à une URL HTTP
 * (ANTHROPIC_BASE_URL de Claude Code). Il n'écoute que sur 127.0.0.1, dans le sandbox.
 */
export function startSocketRelay(socketPath: string, port: number): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect(socketPath);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    }),
  );
}
