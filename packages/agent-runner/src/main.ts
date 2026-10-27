import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { SANDBOX_PATHS, runContextSchema } from "@jules/artifacts";
import { startSocketRelay } from "./broker-client.js";
import { runAgent } from "./run.js";

// Point d'entrée du sandbox, commun à tous les rôles (ARCHITECTURE.md §4.5).

const MODEL_RELAY_PORT = 4001;

const token = process.env.JULES_RUN_TOKEN;
if (!token) {
  process.stderr.write("JULES_RUN_TOKEN manquant\n");
  process.exit(2);
}

const context = runContextSchema.parse(JSON.parse(readFileSync(SANDBOX_PATHS.context, "utf8")));
const relay = await startSocketRelay(SANDBOX_PATHS.brokerSocket, MODEL_RELAY_PORT);
const proxyEnv = Object.fromEntries(
  ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]
    .map((k) => [k, process.env[k]])
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

try {
  const result = await runAgent(context, {
    token,
    socketPath: SANDBOX_PATHS.brokerSocket,
    modelBaseUrl: `http://127.0.0.1:${MODEL_RELAY_PORT}/model`,
    proxyEnv,
    cwd: SANDBOX_PATHS.workspace,
    onMessage: (message) => {
      appendFileSync(SANDBOX_PATHS.transcript, `${JSON.stringify(message)}\n`);
    },
  });
  writeFileSync(SANDBOX_PATHS.result, JSON.stringify(result));
  process.exitCode = result.isError ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(
    SANDBOX_PATHS.result,
    JSON.stringify({
      subtype: "error_during_execution",
      isError: true,
      numTurns: 0,
      totalCostUsd: 0,
      durationMs: 0,
      errors: [message],
    }),
  );
  process.exitCode = 1;
} finally {
  relay.close();
}
