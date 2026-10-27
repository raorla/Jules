import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HostKeyMismatchError,
  SshConnectionError,
  probeHostKey,
  runCommand,
  shellQuote,
  type HostKey,
} from "../src/index.js";
import { generateTestKeyPair, startTestSshServer, type TestSshServer } from "../src/testing.js";

// Exécuteur SSH face à un vrai OpenSSH (images/ssh-test).

const keys = generateTestKeyPair();
let server: TestSshServer;
let hostKey: HostKey;

beforeAll(async () => {
  server = await startTestSshServer(keys.publicKey);
  hostKey = await probeHostKey(server);
}, 600_000);
afterAll(async () => {
  await server.stop();
});

const run = (command: string, overrides: Partial<Parameters<typeof runCommand>[2]> = {}) =>
  runCommand(server, command, {
    privateKey: keys.privateKey,
    pinnedFingerprint: hostKey.fingerprint,
    timeoutSec: 10,
    ...overrides,
  });

describe("clé d'hôte (ARCHITECTURE.md §9)", () => {
  it("lit l'empreinte offerte, identique à celle que l'admin voit sur le serveur", async () => {
    const algorithm = hostKey.algorithm.replace("ssh-", "").split("-")[0]!;
    const onServer = await server.exec(
      `ssh-keygen -lf /etc/ssh/ssh_host_${algorithm === "ed25519" ? "ed25519" : algorithm}_key.pub`,
    );
    expect(hostKey.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(onServer).toContain(hostKey.fingerprint);
  });

  it("refuse un serveur dont la clé ne correspond pas à l'empreinte épinglée, avant toute commande", async () => {
    await server.exec("rm -f /tmp/marker");
    const error = await run("touch /tmp/marker", { pinnedFingerprint: "SHA256:autre" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HostKeyMismatchError);
    expect((error as HostKeyMismatchError).offered.fingerprint).toBe(hostKey.fingerprint);
    expect(await server.exec("test -e /tmp/marker && echo existe || echo absent")).toContain(
      "absent",
    );
  });

  it("échoue proprement quand le serveur est injoignable", async () => {
    await expect(probeHostKey({ host: "127.0.0.1", port: 1, username: "x" }, 2000)).rejects.toThrow(
      SshConnectionError,
    );
  });
});

describe("exécution", () => {
  it("renvoie le code de sortie, la sortie et la durée", async () => {
    const result = await run("echo bonjour; echo erreur >&2; exit 3");
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, truncated: false });
    expect(result.output).toContain("bonjour");
    expect(result.output).toContain("erreur");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("transmet la commande telle quelle, guillemets compris", async () => {
    const result = await run(`printf '%s\\n' "it's" 'a "b"'`);
    expect(result.output).toBe(`it's\na "b"\n`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("coupe une commande trop longue côté serveur", async () => {
    const result = await run("sleep 30", { timeoutSec: 1 });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
  });

  it("garde la fin d'une sortie trop longue", async () => {
    const result = await run("seq 1 50000", { maxOutputChars: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBe(1000);
    expect(result.output.trimEnd().endsWith("50000")).toBe(true);
  });

  it("n'offre aucun terminal : sudo sans -n ne peut rien demander", async () => {
    expect((await run("sudo -n /usr/bin/id -u")).output.trim()).toBe("0");
    const denied = await run("sudo -n /bin/ls /root");
    expect(denied.exitCode).not.toBe(0);
    expect(denied.output).toMatch(/password is required|not allowed|may not run/i);
  });

  it("refuse une clé privée qui n'est pas autorisée", async () => {
    const other = generateTestKeyPair();
    await expect(run("true", { privateKey: other.privateKey })).rejects.toThrow(SshConnectionError);
  });
});
