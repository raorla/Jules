import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSocketRelay } from "./broker-client.js";
import { agentOptions } from "./run.js";

const context = {
  version: 1 as const,
  runId: "00000000-0000-4000-8000-000000000010",
  taskId: "00000000-0000-4000-8000-000000000011",
  role: "developer",
  model: "claude-opus-5-5",
  effort: "xhigh" as const,
  fallbackModel: "claude-sonnet-5-5",
  promptVersion: "developer/v1",
  systemPrompt: "prompt",
  prompt: "demande",
  builtinTools: ["Read", "Write"],
  capabilities: ["submit_build", "git_push"],
  maxTurns: 10,
  maxBudgetUsd: 5,
};

describe("options de l'Agent SDK (ARCHITECTURE.md §4.5)", () => {
  const env = {
    token: "jrt_jeton",
    socketPath: "/run/jules/broker.sock",
    modelBaseUrl: "http://127.0.0.1:4001/model",
    proxyEnv: { HTTPS_PROXY: "http://10.0.0.2:3128" },
    cwd: "/workspace",
  };

  it("ne charge aucun réglage du repo et ne garde que le serveur MCP jules", () => {
    const options = agentOptions(context, env);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["jules"]);
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options).toMatchObject({
      model: "claude-opus-5-5",
      effort: "xhigh",
      fallbackModel: "claude-sonnet-5-5",
      maxTurns: 10,
      maxBudgetUsd: 5,
      tools: ["Read", "Write"],
    });
  });

  it("remplace tout l'environnement : rien d'autre que le jeton d'exécution et le proxy", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-ne-doit-pas-passer";
    process.env.GITHUB_TOKEN = "ghs_ne_doit_pas_passer";
    const options = agentOptions(context, env);
    expect(Object.keys(options.env ?? {}).sort()).toEqual(
      [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_AGENT_SDK_CLIENT_APP",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "DISABLE_AUTOUPDATER",
        "DISABLE_ERROR_REPORTING",
        "DISABLE_TELEMETRY",
        "HOME",
        "HTTPS_PROXY",
        "PATH",
      ].sort(),
    );
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe("jrt_jeton");
    expect(JSON.stringify(options.env)).not.toContain("ne-doit-pas-passer");
    expect(JSON.stringify(options.env)).not.toContain("ne_doit_pas_passer");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
  });
});

describe("relais vers le broker", () => {
  it("relaie le HTTP de 127.0.0.1 vers le socket Unix", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "jules-relay-")), "broker.sock");
    const broker = createServer((req, res) => res.end(`vu ${req.url ?? ""}`));
    await new Promise<void>((r) => broker.listen(socketPath, r));
    const relay = await startSocketRelay(socketPath, 0);
    const port = (relay.address() as { port: number }).port;

    const text = await new Promise<string>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path: "/model/v1/messages" }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          resolve(body);
        });
      })
        .on("error", reject)
        .end();
    });
    expect(text).toBe("vu /model/v1/messages");
    relay.close();
    broker.close();
  });
});
