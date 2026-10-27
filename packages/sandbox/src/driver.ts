import Docker from "dockerode";
import type { EgressDecision } from "./egress-proxy.js";

// Driver des sandboxes (ARCHITECTURE.md §8). Pour chaque exécution :
// - un réseau interne propre, sans passerelle vers l'hôte (gateway_mode_ipv4=isolated) ;
// - un egress proxy propre, seul conteneur de ce réseau relié à Internet ;
// - le sandbox, durci (non root, aucune capability, racine en lecture seule, limites) ;
// - tout est détruit à la fin, même en cas d'erreur, et un ménage rattrape ce qu'un crash aurait laissé.
// Le broker n'est pas sur le réseau : il est joint par un socket Unix monté dans le sandbox.

export const SANDBOX_LABEL = "jules.sandbox";
export const RUN_LABEL = "jules.run";
const EGRESS_ALIAS = "egress";
const EGRESS_PORT = 3128;

export type Limits = {
  cpus: number;
  memoryMb: number;
  pids: number;
  timeoutMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  cpus: 2,
  memoryMb: 4096,
  pids: 512,
  timeoutMs: 45 * 60_000,
};

export type Mount = { source: string; target: string; readOnly: boolean };

export type RunSpec = {
  runId: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  mounts?: readonly Mount[];
  /** `egress` : réseau propre + proxy avec allowlist. `none` : aucun réseau (export des commits). */
  network: { kind: "egress"; allow: readonly string[] } | { kind: "none" };
  limits?: Partial<Limits>;
  user?: string;
  workdir?: string;
};

export type RunOutcome = {
  exitCode: number;
  timedOut: boolean;
  /** Arrêté de l'extérieur (`stop`, arrêt d'urgence, budget). */
  stopped: boolean;
  logs: string;
  egress: EgressDecision[];
};

export type DriverOptions = {
  /** `runsc` (gVisor) en production ; `runc` seulement pour le développement. */
  runtime: string;
  egressImage: string;
  /** Réseau ordinaire, relié à Internet, auquel seuls les egress proxies sont attachés. */
  egressNetwork?: string;
};

/** Démultiplexe la sortie de `docker logs` (en-têtes de 8 octets par trame). */
export function demuxLogs(buffer: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    out += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return out;
}

export class SandboxDriver {
  readonly #docker: Docker;
  readonly #options: Required<DriverOptions>;
  readonly #stopped = new Set<string>();

  constructor(options: DriverOptions, docker: Docker = new Docker()) {
    this.#docker = docker;
    this.#options = { egressNetwork: "jules-egress", ...options };
  }

  async #ensureEgressNetwork(): Promise<void> {
    const name = this.#options.egressNetwork;
    const existing = await this.#docker.listNetworks({ filters: { name: [name] } });
    if (!existing.some((n) => n.Name === name)) {
      await this.#docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: { [SANDBOX_LABEL]: "egress" },
      });
    }
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const limits = { ...DEFAULT_LIMITS, ...spec.limits };
    const labels = { [SANDBOX_LABEL]: "1", [RUN_LABEL]: spec.runId };
    const cleanup: (() => Promise<unknown>)[] = [];
    let egressContainer: Docker.Container | undefined;
    let networkMode = "none";
    const env: Record<string, string> = { ...spec.env };

    try {
      if (spec.network.kind === "egress") {
        await this.#ensureEgressNetwork();
        const network = await this.#docker.createNetwork({
          Name: `jules-run-${spec.runId}`,
          Driver: "bridge",
          Internal: true,
          Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
          Labels: labels,
        });
        cleanup.push(() => network.remove());
        networkMode = `jules-run-${spec.runId}`;

        egressContainer = await this.#docker.createContainer({
          Image: this.#options.egressImage,
          name: `jules-egress-${spec.runId}`,
          Env: [
            `JULES_EGRESS_ALLOW=${spec.network.allow.join(",")}`,
            `JULES_EGRESS_PORT=${EGRESS_PORT}`,
          ],
          User: "1000:1000",
          Labels: { ...labels, "jules.role": "egress" },
          HostConfig: {
            NetworkMode: networkMode,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            PidsLimit: 64,
            Memory: 128 * 1024 * 1024,
          },
          NetworkingConfig: { EndpointsConfig: { [networkMode]: { Aliases: [EGRESS_ALIAS] } } },
        });
        const egress = egressContainer;
        cleanup.push(() => egress.remove({ force: true }));
        await this.#docker
          .getNetwork(this.#options.egressNetwork)
          .connect({ Container: egress.id });
        await egress.start();

        const proxy = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
        Object.assign(env, {
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NO_PROXY: "localhost,127.0.0.1",
          no_proxy: "localhost,127.0.0.1",
        });
      }

      const container = await this.#docker.createContainer({
        Image: spec.image,
        name: `jules-sandbox-${spec.runId}`,
        ...(spec.command ? { Cmd: spec.command } : {}),
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        User: spec.user ?? "1000:1000",
        WorkingDir: spec.workdir ?? "/workspace",
        Labels: { ...labels, "jules.role": "sandbox" },
        HostConfig: {
          Runtime: this.#options.runtime,
          NetworkMode: networkMode,
          Binds: (spec.mounts ?? []).map(
            (m) => `${m.source}:${m.target}:${m.readOnly ? "ro" : "rw"}`,
          ),
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "rw,nosuid,nodev,size=1g", "/home/node": "rw,nosuid,nodev,size=512m" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: limits.pids,
          Memory: limits.memoryMb * 1024 * 1024,
          NanoCpus: Math.round(limits.cpus * 1e9),
        },
      });
      cleanup.push(() => container.remove({ force: true }));
      await container.start();

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void container.kill().catch(() => undefined);
      }, limits.timeoutMs);
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      clearTimeout(timer);

      const logs = demuxLogs(
        (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer,
      );
      const egress = egressContainer ? await this.#egressDecisions(egressContainer) : [];
      return {
        exitCode: StatusCode,
        timedOut,
        stopped: this.#stopped.has(spec.runId),
        logs,
        egress,
      };
    } finally {
      this.#stopped.delete(spec.runId);
      for (const step of cleanup.reverse()) {
        await step().catch(() => undefined);
      }
    }
  }

  async #egressDecisions(container: Docker.Container): Promise<EgressDecision[]> {
    const raw = demuxLogs(
      (await container.logs({ stdout: true, stderr: false })) as unknown as Buffer,
    );
    return raw
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as EgressDecision);
  }

  /** Tue les conteneurs d'une exécution. Le `run()` en cours se termine avec `stopped: true`. */
  async stop(runId: string): Promise<number> {
    this.#stopped.add(runId);
    return this.#kill({ label: [`${RUN_LABEL}=${runId}`] });
  }

  /** Arrêt d'urgence : tue tous les sandboxes et egress proxies, de toutes les exécutions. */
  async stopAll(): Promise<number> {
    return this.#kill({ label: [`${SANDBOX_LABEL}=1`] });
  }

  async #kill(filters: Record<string, string[]>): Promise<number> {
    const containers = await this.#docker.listContainers({ all: true, filters });
    await Promise.all(
      containers.map(async (c) => {
        const runId = c.Labels[RUN_LABEL];
        if (runId) {
          this.#stopped.add(runId);
        }
        await this.#docker
          .getContainer(c.Id)
          .kill()
          .catch(() => undefined);
      }),
    );
    return containers.length;
  }

  /** Supprime ce qu'un crash du worker aurait laissé : conteneurs et réseaux des exécutions terminées. */
  async reap(activeRunIds: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: [`${SANDBOX_LABEL}=1`] },
    });
    for (const c of containers) {
      const runId = c.Labels[RUN_LABEL];
      if (runId && !activeRunIds.has(runId)) {
        await this.#docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => undefined);
        removed += 1;
      }
    }
    const networks = await this.#docker.listNetworks({
      filters: { label: [`${SANDBOX_LABEL}=1`] },
    });
    for (const n of networks) {
      const runId = n.Labels?.[RUN_LABEL];
      if (runId && !activeRunIds.has(runId)) {
        await this.#docker
          .getNetwork(n.Id)
          .remove()
          .catch(() => undefined);
      }
    }
    return removed;
  }
}
