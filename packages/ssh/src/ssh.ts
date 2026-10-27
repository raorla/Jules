import { createHash } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";

// Exécuteur SSH du worker (ARCHITECTURE.md §9). La clé privée reste en mémoire du worker le temps
// d'une connexion : jamais sur disque, jamais dans un sandbox. La clé d'hôte est épinglée ; si elle
// change, la connexion est refusée avant toute authentification. Pas de terminal, stdin fermé :
// `sudo` ne peut demander aucun mot de passe (seul `sudo -n` fonctionne).

export type SshTarget = { readonly host: string; readonly port: number; readonly username: string };

export type HostKey = { readonly algorithm: string; readonly fingerprint: string };

export class HostKeyMismatchError extends Error {
  constructor(
    readonly offered: HostKey,
    readonly pinned: string,
  ) {
    super(`clé d'hôte changée : ${offered.fingerprint} au lieu de ${pinned}`);
  }
}

export class SshConnectionError extends Error {}

export type CommandResult = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Fin de la sortie (stdout puis stderr), tronquée au début si elle dépasse la limite. */
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
};

const READY_TIMEOUT_MS = 10_000;

/** Empreinte au format OpenSSH : `SHA256:` puis le condensé en base64 sans `=`. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Algorithme d'une clé d'hôte au format SSH (chaîne préfixée par sa longueur). */
function algorithmOf(key: Buffer): string {
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString("ascii");
}

/** Quote POSIX : la commande entière devient un seul argument de `sh -c`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Lit la clé d'hôte offerte par le serveur, sans s'authentifier. Elle est montrée à un admin, qui la
 * compare à celle du serveur (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) avant de la valider.
 */
export function probeHostKey(target: SshTarget, timeoutMs = READY_TIMEOUT_MS): Promise<HostKey> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let offered: HostKey | undefined;
    const done = () => {
      client.end();
      if (offered) {
        resolve(offered);
      } else {
        reject(new SshConnectionError(`aucune clé d'hôte reçue de ${target.host}:${target.port}`));
      }
    };
    client.on("error", done);
    client.on("close", done);
    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        offered = { algorithm: algorithmOf(key), fingerprint: fingerprint(key) };
        return false;
      },
    });
  });
}

export type RunOptions = {
  readonly privateKey: string;
  /** Empreinte validée par un admin. Toute autre clé est refusée. */
  readonly pinnedFingerprint: string;
  readonly timeoutSec: number;
  readonly maxOutputChars?: number;
};

/**
 * Exécute une commande déjà classée et autorisée. Le délai est appliqué des deux côtés : `timeout` sur
 * le serveur, et une coupure de la connexion côté worker si le serveur ne rend pas la main.
 */
export function runCommand(
  target: SshTarget,
  command: string,
  options: RunOptions,
): Promise<CommandResult> {
  const max = options.maxOutputChars ?? 30_000;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const client = new Client();
    let mismatch: HostKeyMismatchError | undefined;
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > max * 2) {
        output = output.slice(-max);
        truncated = true;
      }
    };
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      client.end();
      const clipped = output.length > max;
      resolve({
        exitCode,
        signal,
        output: clipped ? output.slice(-max) : output,
        truncated: truncated || clipped,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      client.end();
      reject(mismatch ?? error);
    };
    const guard = setTimeout(
      () => {
        timedOut = true;
        finish(null, "TIMEOUT");
      },
      (options.timeoutSec + 10) * 1000,
    );
    client.on("ready", () => {
      const remote = `timeout --kill-after=5s ${options.timeoutSec}s sh -c ${shellQuote(command)}`;
      client.exec(remote, (error, stream) => {
        if (error) {
          fail(new SshConnectionError(`exécution refusée par le serveur : ${error.message}`));
          return;
        }
        stream.end();
        stream.on("data", append);
        stream.stderr.on("data", append);
        stream.on("close", (code: number | null, signal: string | null) => {
          // `timeout` sort avec 124 quand le délai côté serveur est atteint.
          timedOut = timedOut || code === 124;
          finish(code ?? null, signal ?? null);
        });
      });
    });
    client.on("error", (error) => {
      fail(new SshConnectionError(error.message));
    });
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: options.privateKey,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        const offered = fingerprint(key);
        if (offered === options.pinnedFingerprint) {
          return true;
        }
        mismatch = new HostKeyMismatchError(
          { algorithm: algorithmOf(key), fingerprint: offered },
          options.pinnedFingerprint,
        );
        return false;
      },
    };
    client.connect(config);
  });
}
