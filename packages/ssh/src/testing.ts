import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { utils } from "ssh2";

// Vrai serveur OpenSSH pour les tests (images/ssh-test). Chaque conteneur génère ses clés d'hôte au
// démarrage : en recréer un simule un serveur dont la clé a changé.

const IMAGE = "jules-ssh-test:test";
const CONTEXT = fileURLToPath(new URL("../../../images/ssh-test", import.meta.url));
let built: Promise<void> | undefined;

function buildImage(): Promise<void> {
  built ??= new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["build", "-q", "-t", IMAGE, CONTEXT],
      { timeout: 600_000 },
      (error, _out, stderr) => {
        if (error) {
          reject(new Error(`docker build ssh-test : ${stderr}`));
        } else {
          resolve();
        }
      },
    );
  });
  return built;
}

export type TestKeyPair = { readonly privateKey: string; readonly publicKey: string };

export function generateTestKeyPair(): TestKeyPair {
  const pair = utils.generateKeyPairSync("ed25519");
  return { privateKey: pair.private, publicKey: pair.public };
}

export type TestSshServer = {
  readonly host: string;
  readonly port: number;
  readonly username: "jules";
  /** Commande lancée dans le conteneur, pour vérifier l'effet d'une action (root). */
  exec(command: string): Promise<string>;
  stop(): Promise<void>;
};

export async function startTestSshServer(authorizedKey: string): Promise<TestSshServer> {
  await buildImage();
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withEnvironment({ AUTHORIZED_KEY: authorizedKey })
    .withExposedPorts(22)
    .withWaitStrategy(Wait.forLogMessage(/Server listening/))
    .start();
  return {
    host: container.getHost(),
    port: container.getMappedPort(22),
    username: "jules",
    async exec(command) {
      const result = await container.exec(["sh", "-c", command]);
      return result.output;
    },
    async stop() {
      await container.stop();
    },
  };
}
