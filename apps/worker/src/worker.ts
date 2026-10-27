import { CHANNELS } from "@jules/db";
import type { SecretStore } from "@jules/secrets";
import { checkAppSetup } from "@jules/forge";
import pg from "pg";
import type { WorkerDeps } from "./deps.js";
import { drainEvents } from "./inbox.js";
import { drainOutbox } from "./outbox.js";
import type { DeploymentService } from "./devops/deployments.js";
import type { PlanService } from "./devops/plans.js";
import type { ServerService } from "./devops/servers.js";
import type { AuditService } from "./security/audits.js";
import type { Orchestrator } from "./orchestrator.js";
import { purgeExpired } from "./retention.js";
import { drainSecretSubmissions } from "./sealed-secrets.js";
import { drainWebCommands } from "./web-commands.js";
import { GITHUB_DELIVERY_RETENTION_MS, reconcileDeliveries } from "./reconcile.js";

// Boucle du worker. LISTEN/NOTIFY réveille le traitement dès qu'un événement ou un effet arrive ;
// une scrutation lente rattrape une notification perdue (connexion coupée, worker arrêté).

export type WorkerOptions = {
  databaseUrl: string;
  /** Sans orchestrateur (M0), le worker traite les événements et les effets seulement. */
  orchestrator?: Orchestrator;
  /** Dossier des exécutions : la purge de rétention y passe toutes les heures. */
  runsDir?: string;
  /** Coffre des secrets : le worker y importe ceux saisis dans l'interface (scellés pour lui). */
  secrets?: SecretStore;
  /** Agent DevOps (M7) : clés d'hôte, plans approuvés, pipeline de déploiement. */
  devops?: { servers: ServerService; plans: PlanService; deployments: DeploymentService };
  /** Agent Sécurité (M8) : audits planifiés, demandés ou déclenchés par un merge. */
  security?: { audits: AuditService };
  pollMs?: number;
  reconcileEveryMs?: number;
  reconcileLookbackMs?: number;
};

export class AppSetupError extends Error {
  override readonly name = "AppSetupError";
  constructor(readonly problems: string[]) {
    super(`configuration de la GitHub App refusée :\n- ${problems.join("\n- ")}`);
  }
}

type LoopName = "events" | "outbox" | "tasks" | "commands" | "devops" | "security";
type Loop = { running: boolean; again: boolean; run: () => Promise<number> };

export class Worker {
  readonly #deps: WorkerDeps;
  readonly #options: Required<
    Omit<WorkerOptions, "orchestrator" | "runsDir" | "secrets" | "devops" | "security">
  >;
  readonly #devops: WorkerOptions["devops"];
  readonly #runsDir: string | undefined;
  readonly #orchestrator: Orchestrator | undefined;
  readonly #loops: Record<LoopName, Loop>;
  readonly #timers: NodeJS.Timeout[] = [];
  #listener: pg.Client | undefined;
  #stopped = false;

  constructor(deps: WorkerDeps, options: WorkerOptions) {
    this.#deps = deps;
    const { orchestrator, runsDir, secrets, devops, security, ...rest } = options;
    let lastSchedule = 0;
    this.#runsDir = runsDir;
    this.#devops = devops;
    this.#options = {
      pollMs: 5_000,
      reconcileEveryMs: 10 * 60_000,
      reconcileLookbackMs: 6 * 3600_000,
      ...rest,
    };
    this.#orchestrator = orchestrator;
    this.#loops = {
      events: { running: false, again: false, run: () => drainEvents(deps) },
      outbox: { running: false, again: false, run: () => drainOutbox(deps) },
      tasks: {
        running: false,
        again: false,
        run: () => (orchestrator ? orchestrator.drainTasks() : Promise.resolve(0)),
      },
      commands: {
        running: false,
        again: false,
        run: async () =>
          (await drainWebCommands(deps)) +
          (secrets ? await drainSecretSubmissions(deps.db, secrets) : 0),
      },
      devops: {
        running: false,
        again: false,
        run: async () =>
          devops
            ? (await devops.servers.probePending()) +
              (await devops.plans.expire()) +
              (await devops.deployments.advance()) +
              (await devops.plans.drain())
            : 0,
      },
      security: {
        running: false,
        again: false,
        run: async () => {
          if (!security) {
            return 0;
          }
          // Planification et échéances : toutes les dix minutes suffisent.
          let count = 0;
          if (Date.now() - lastSchedule > 600_000) {
            lastSchedule = Date.now();
            count +=
              (await security.audits.schedule()) + (await security.audits.expireAcceptedRisks());
          }
          return count + (await security.audits.drain());
        },
      },
    };
  }

  async start(): Promise<void> {
    await this.#checkApp();
    await this.#listen();
    // Au démarrage, on remonte tout l'historique gardé par GitHub : rattrape une panne du gateway.
    await this.reconcile(GITHUB_DELIVERY_RETENTION_MS);
    // Reprise après crash : exécutions orphelines arrêtées, tâches au bail expiré relancées.
    await this.#recover();
    // Un plan resté `running` est déclaré interrompu, une seule fois au démarrage : jamais relancé.
    const interrupted = (await this.#devops?.plans.recover()) ?? 0;
    if (interrupted > 0) {
      this.#deps.log.warn({ interrupted }, "plans interrompus par l'arrêt du worker");
    }
    this.#kick("events");
    this.#kick("outbox");
    this.#kick("tasks");
    this.#kick("commands");
    this.#kick("devops");
    this.#kick("security");
    this.#timers.push(
      setInterval(() => {
        this.#kick("events");
        this.#kick("outbox");
        this.#kick("tasks");
        this.#kick("commands");
        this.#kick("devops");
        this.#kick("security");
      }, this.#options.pollMs),
      setInterval(() => void this.#recover(), 60_000),
      setInterval(() => void this.#purge(), 3600_000),
      setInterval(
        () => void this.reconcile(this.#options.reconcileLookbackMs),
        this.#options.reconcileEveryMs,
      ),
    );
  }

  async #purge(): Promise<void> {
    if (!this.#runsDir) {
      return;
    }
    try {
      const report = await purgeExpired(this.#deps.db, {
        runsDir: this.#runsDir,
        ...(this.#orchestrator ? { activeRuns: this.#orchestrator.activeRuns } : {}),
      });
      this.#deps.log.info(report, "purge de rétention");
    } catch (error) {
      this.#deps.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "purge impossible",
      );
    }
  }

  async #recover(): Promise<void> {
    try {
      const recovered = (await this.#orchestrator?.recover()) ?? 0;
      if (recovered > 0) {
        this.#deps.log.warn({ recovered }, "reprise après redémarrage");
      }
    } catch (error) {
      this.#deps.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "reprise impossible",
      );
    }
  }

  /** Refuse de démarrer si l'App a une permission interdite (ARCHITECTURE.md §12). */
  async #checkApp(): Promise<void> {
    const app = await this.#deps.github.getApp();
    const report = checkAppSetup(app);
    report.warnings.forEach((warning) => {
      this.#deps.log.warn({ app: app.slug }, warning);
    });
    if (report.errors.length > 0) {
      throw new AppSetupError(report.errors);
    }
  }

  async reconcile(lookbackMs: number): Promise<void> {
    try {
      const report = await reconcileDeliveries(this.#deps, { lookbackMs });
      this.#deps.log.info(report, "réconciliation des webhooks");
    } catch (error) {
      // GitHub injoignable : on réessaiera au prochain passage, sans bloquer le reste.
      this.#deps.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "réconciliation impossible",
      );
    }
  }

  #kick(name: LoopName): void {
    const loop = this.#loops[name];
    if (this.#stopped) {
      return;
    }
    if (loop.running) {
      loop.again = true;
      return;
    }
    loop.running = true;
    void (async () => {
      do {
        loop.again = false;
        try {
          const processed = await loop.run();
          // Un événement traité produit souvent un effet et une tâche : on enchaîne sans attendre.
          if (processed > 0 && name === "events") {
            this.#kick("outbox");
            this.#kick("tasks");
          }
        } catch (error) {
          this.#deps.log.error(
            { err: error instanceof Error ? error.message : String(error), loop: name },
            "boucle en erreur",
          );
        }
      } while (this.#rerun(loop));
      loop.running = false;
    })();
  }

  /** `again` change pendant `run()` : un appel de méthode évite que TypeScript le croie constant. */
  #rerun(loop: Loop): boolean {
    return loop.again && !this.#stopped;
  }

  async #listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.#options.databaseUrl });
    client.on("notification", (message) => {
      this.#kick(
        message.channel === CHANNELS.outbox
          ? "outbox"
          : message.channel === CHANNELS.commands
            ? "commands"
            : "events",
      );
    });
    client.on("error", (error) => {
      this.#deps.log.warn({ err: error.message }, "connexion LISTEN perdue, reconnexion");
      this.#listener = undefined;
      void client.end().catch(() => undefined);
      if (!this.#stopped) {
        setTimeout(() => void this.#listen().catch(() => undefined), 2_000);
      }
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNELS.events}`);
    await client.query(`LISTEN ${CHANNELS.outbox}`);
    await client.query(`LISTEN ${CHANNELS.commands}`);
    this.#listener = client;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timers.forEach(clearInterval);
    await this.#listener?.end();
    // Laisse les boucles en cours finir leur élément : la réservation expirerait sinon.
    while (Object.values(this.#loops).some((l) => l.running)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
