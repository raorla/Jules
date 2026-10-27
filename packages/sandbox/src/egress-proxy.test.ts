import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  isHostAllowed,
  parseAllowlist,
  type EgressDecision,
} from "./egress-proxy.js";

describe("allowlist", () => {
  const allow = parseAllowlist(" registry.npmjs.org, *.pythonhosted.org ,");

  it.each([
    ["registry.npmjs.org", true],
    ["REGISTRY.npmjs.org.", true],
    ["files.pythonhosted.org", true],
    ["pythonhosted.org", false],
    ["evilpythonhosted.org", false],
    ["registry.npmjs.org.evil.com", false],
    ["example.com", false],
  ])("%s → %s", (host, expected) => {
    expect(isHostAllowed(host, allow)).toBe(expected);
  });
});

describe("proxy", () => {
  let target: Server;
  let proxy: Server;
  let targetPort: number;
  let proxyPort: number;
  const decisions: EgressDecision[] = [];

  beforeAll(async () => {
    target = createServer((_req, res) => res.end("bonjour"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetPort = (target.address() as AddressInfo).port;
    proxy = createEgressProxy({
      allow: ["localhost"],
      ports: [targetPort],
      onDecision: (d) => decisions.push(d),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => {
    target.close();
    proxy.close();
  });

  const tunnel = (authority: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(proxyPort, "127.0.0.1", () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      socket.once("data", (chunk) => {
        resolve(chunk.toString().split("\r\n")[0] ?? "");
        socket.destroy();
      });
      socket.on("error", reject);
    });

  const plain = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: proxyPort, path: url, method: "GET" },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("ouvre un tunnel vers un hôte autorisé", async () => {
    expect(await tunnel(`localhost:${targetPort}`)).toBe("HTTP/1.1 200 Connection Established");
  });

  it.each([
    ["un hôte hors allowlist", "example.com:443"],
    ["une IP littérale", "93.184.215.14:443"],
    ["un port non autorisé", "localhost:22"],
  ])("refuse %s et le journalise", async (_, authority) => {
    expect(await tunnel(authority)).toBe("HTTP/1.1 403 Forbidden");
    expect(decisions.at(-1)).toMatchObject({ allowed: false, method: "CONNECT" });
  });

  it("survit à un client qui coupe brutalement après un refus", async () => {
    await new Promise<void>((resolve) => {
      const socket = connect(proxyPort, "127.0.0.1", () => {
        socket.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
        socket.resetAndDestroy();
        setTimeout(resolve, 100);
      });
    });
    expect(await tunnel(`localhost:${targetPort}`)).toBe("HTTP/1.1 200 Connection Established");
  });

  it("relaie le HTTP en clair autorisé et refuse le reste", async () => {
    expect(await plain(`http://localhost:${targetPort}/x`)).toEqual({
      status: 200,
      body: "bonjour",
    });
    expect((await plain("http://example.com/")).status).toBe(403);
    expect((await plain("/relative")).status).toBe(400);
  });
});
