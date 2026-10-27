import { CHANNELS } from "@jules/db";
import { checkAppSetup } from "@jules/forge";
import pg from "pg";
import type { WorkerDeps } from "./deps.js";
import { drainEvents } from "./inbox.js";
import { drainOutbox } from "./outbox.js";
import { GITHUB_DELIVERY_RETENTION_MS, reconcileDeliveries } from "./reconcile.js";

// Boucle du worker. LISTEN/NOTIFY réveille le traitement dès qu'un événement ou un effet arrive ;
// une scrutation lente rattrape une notification perdue (connexion coupée, worker arrêté).

export type WorkerOptions = {
  databaseUrl: string;
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

type Loop = { running: boolean; again: boolean; run: () => Promise<number> };

export class Worker {
  readonly #deps: WorkerDeps;
  readonly #options: Required<WorkerOptions>;
  readonly #loops: Record<"events" | "outbox", Loop>;
  readonly #timers: NodeJS.Timeout[] = [];
  #listener: pg.Client | undefined;
  #stopped = false;

  constructor(deps: WorkerDeps, options: WorkerOptions) {
    this.#deps = deps;
    this.#options = {
      pollMs: 5_000,
      reconcileEveryMs: 10 * 60_000,
      reconcileLookbackMs: 6 * 3600_000,
      ...options,
    };
    this.#loops = {
      events: { running: false, again: false, run: () => drainEvents(deps) },
      outbox: { running: false, again: false, run: () => drainOutbox(deps) },
    };
  }

  async start(): Promise<void> {
    await this.#checkApp();
    await this.#listen();
    // Au démarrage, on remonte tout l'historique gardé par GitHub : rattrape une panne du gateway.
    await this.reconcile(GITHUB_DELIVERY_RETENTION_MS);
    this.#kick("events");
    this.#kick("outbox");
    this.#timers.push(
      setInterval(() => {
        this.#kick("events");
        this.#kick("outbox");
      }, this.#options.pollMs),
      setInterval(
        () => void this.reconcile(this.#options.reconcileLookbackMs),
        this.#options.reconcileEveryMs,
      ),
    );
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

  #kick(name: "events" | "outbox"): void {
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
          // Un événement traité produit souvent un effet : on enchaîne sans attendre la notification.
          if (processed > 0 && name === "events") {
            this.#kick("outbox");
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
      this.#kick(message.channel === CHANNELS.outbox ? "outbox" : "events");
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
