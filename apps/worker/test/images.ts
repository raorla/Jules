import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// Images de test construites depuis deploy/Dockerfile : le cache de Docker rend la reconstruction
// rapide quand le code n'a pas changé. JULES_TEST_SKIP_BUILD=1 réutilise les images existantes.

export const TEST_IMAGES = {
  sandbox: "jules-sandbox-node:test",
  egress: "jules-egress:test",
} as const;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function build(target: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["build", "-q", "-f", "deploy/Dockerfile", "--target", target, "-t", tag, "."],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 900_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`docker build ${target} : ${stderr}`));
        } else {
          resolve();
        }
      },
    );
  });
}

let built: Promise<void> | undefined;

export function ensureTestImages(): Promise<void> {
  if (process.env.JULES_TEST_SKIP_BUILD === "1") {
    return Promise.resolve();
  }
  built ??= build("egress", TEST_IMAGES.egress).then(() =>
    build("sandbox-node", TEST_IMAGES.sandbox),
  );
  return built;
}
