import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { capabilityDescriptions, capabilityInputs, isCapabilityName } from "@jules/artifacts";
import { callCapability } from "./broker-client.js";

// Serveur MCP `jules`, en processus : il déclare les outils du rôle et transmet chaque appel au broker.
// Il ne décide rien et ne stocke rien : le broker revalide tout.

export function julesMcpServer(options: {
  socketPath: string;
  token: string;
  capabilities: readonly string[];
}) {
  const tools = options.capabilities.filter(isCapabilityName).map((name) =>
    tool(name, capabilityDescriptions[name], capabilityInputs[name].shape, async (args) => {
      try {
        const res = await callCapability(options.socketPath, options.token, name, args);
        return { content: [{ type: "text" as const, text: res.text }], isError: res.status >= 400 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Broker injoignable : ${message}` }],
          isError: true,
        };
      }
    }),
  );
  return createSdkMcpServer({ name: "jules", version: "1.0.0", tools, alwaysLoad: true });
}
