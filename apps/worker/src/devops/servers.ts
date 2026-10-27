import { appendAudit } from "@jules/audit";
import { and, eq, serverCommands, servers, sql, type Db, type DbOrTx } from "@jules/db";
import type { CommandClass } from "@jules/devops";
import type { Decision } from "@jules/policy";
import type { SecretStore } from "@jules/secrets";
import {
  HostKeyMismatchError,
  probeHostKey,
  runCommand,
  type CommandResult,
  type HostKey,
} from "@jules/ssh";
import type { Logger } from "pino";
import { Masker } from "../broker/masking.js";

// Accès aux serveurs (ARCHITECTURE.md §9). Seul le worker se connecte : la clé privée est déchiffrée
// en mémoire le temps d'une commande, puis oubliée. Elle n'entre jamais dans un sandbox, un log ou
// l'audit, et la sortie est masquée avec la clé elle-même en plus des secrets connus.

export type ServerRow = typeof servers.$inferSelect;

export type SshPort = {
  run: typeof runCommand;
  probe: (target: { host: string; port: number; username: string }) => Promise<HostKey>;
};

export type ServerServiceDeps = {
  db: Db;
  secrets: SecretStore;
  masker: Masker;
  log: Logger;
  ssh?: SshPort;
  /** Délai maximum d'une commande côté serveur. */
  commandTimeoutSec?: number;
};

/** Nom du secret qui porte la clé privée d'un serveur (saisie scellée dans l'interface). */
export function sshKeyName(serverId: string): string {
  return `ssh_key_${serverId.replaceAll("-", "")}`;
}

export function hostKeyTrusted(server: ServerRow): boolean {
  return server.hostKeyStatus === "trusted" && server.hostKeyFingerprint !== null;
}

export type ExecMeta = {
  source: "agent" | "plan" | "deployment" | "audit";
  runId?: string;
  planId?: string;
  commandClass: CommandClass;
  decision: Decision;
  timeoutSec?: number;
  /** `false` : la sortie n'est pas gardée dans l'historique (audit de sécurité, défense en profondeur). */
  keepOutput?: boolean;
};

export class ServerService {
  readonly #deps: ServerServiceDeps;
  readonly #ssh: SshPort;

  constructor(deps: ServerServiceDeps) {
    this.#deps = deps;
    this.#ssh = deps.ssh ?? { run: runCommand, probe: (target) => probeHostKey(target) };
  }

  async byName(db: DbOrTx, orgId: string, name: string): Promise<ServerRow | undefined> {
    const [row] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.orgId, orgId), eq(servers.name, name)));
    return row;
  }

  async byId(db: DbOrTx, id: string): Promise<ServerRow | undefined> {
    const [row] = await db.select().from(servers).where(eq(servers.id, id));
    return row;
  }

  /** Commande refusée par la policy : journalisée comme les autres, sans rien envoyer au serveur. */
  async recordRefusal(
    db: DbOrTx,
    server: ServerRow,
    command: string,
    meta: Omit<ExecMeta, "timeoutSec">,
  ): Promise<void> {
    await db.insert(serverCommands).values({
      orgId: server.orgId,
      serverId: server.id,
      runId: meta.runId ?? null,
      planId: meta.planId ?? null,
      source: meta.source,
      command: this.#deps.masker.mask(command),
      commandClass: meta.commandClass,
      decision: meta.decision.effect,
      ruleId: meta.decision.ruleId,
      output: meta.decision.reason,
    });
  }

  /**
   * Exécute une commande déjà classée et autorisée. Une clé d'hôte différente de celle validée bloque
   * le serveur : plus rien n'y passe tant qu'un admin n'a pas revalidé la nouvelle empreinte.
   */
  async execute(server: ServerRow, command: string, meta: ExecMeta): Promise<CommandResult> {
    const { db, secrets, log } = this.#deps;
    if (!hostKeyTrusted(server) || server.hostKeyFingerprint === null) {
      throw new Error(`clé d'hôte de ${server.name} non validée`);
    }
    const key = await secrets.get(server.orgId, sshKeyName(server.id));
    if (!key) {
      throw new Error(`clé SSH de ${server.name} absente`);
    }
    const privateKey = key.toString("utf8");
    const keyMasker = new Masker([privateKey]);
    let result: CommandResult;
    try {
      result = await this.#ssh.run(
        { host: server.host, port: server.port, username: server.username },
        command,
        {
          privateKey,
          pinnedFingerprint: server.hostKeyFingerprint,
          timeoutSec: meta.timeoutSec ?? this.#deps.commandTimeoutSec ?? 120,
        },
      );
    } catch (error) {
      if (error instanceof HostKeyMismatchError) {
        await this.markHostKeyChanged(server, error.offered);
      }
      throw error;
    }
    const output = this.#deps.masker.mask(keyMasker.mask(result.output));
    const [row] = await db
      .insert(serverCommands)
      .values({
        orgId: server.orgId,
        serverId: server.id,
        runId: meta.runId ?? null,
        planId: meta.planId ?? null,
        source: meta.source,
        command: this.#deps.masker.mask(command),
        commandClass: meta.commandClass,
        decision: meta.decision.effect,
        ruleId: meta.decision.ruleId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        output: meta.keepOutput === false ? "sortie non conservée (audit de sécurité)" : output,
      })
      .returning({ id: serverCommands.id });
    await appendAudit(db, {
      orgId: server.orgId,
      actor: { type: "system", id: "worker" },
      action: "server.command",
      target: { type: "server", id: server.id },
      data: {
        commandId: row?.id ?? null,
        source: meta.source,
        class: meta.commandClass,
        exitCode: result.exitCode,
        ...(meta.planId ? { planId: meta.planId } : {}),
      },
    });
    log.info(
      { serverId: server.id, exitCode: result.exitCode, durationMs: result.durationMs },
      "commande serveur",
    );
    return { ...result, output };
  }

  async markHostKeyChanged(server: ServerRow, offered: HostKey): Promise<void> {
    await this.#deps.db
      .update(servers)
      .set({
        hostKeyStatus: "changed",
        offeredFingerprint: offered.fingerprint,
        offeredAlgorithm: offered.algorithm,
        updatedAt: sql`now()`,
      })
      .where(eq(servers.id, server.id));
    await appendAudit(this.#deps.db, {
      orgId: server.orgId,
      actor: { type: "system", id: "worker" },
      action: "server.host_key_changed",
      target: { type: "server", id: server.id },
      data: { offered: offered.fingerprint, pinned: server.hostKeyFingerprint },
    });
    this.#deps.log.error({ serverId: server.id }, "clé d'hôte changée : serveur bloqué");
  }

  /** Lit la clé d'hôte des serveurs nouvellement enregistrés, pour qu'un admin la valide. */
  async probePending(): Promise<number> {
    const { db } = this.#deps;
    const pending = await db.select().from(servers).where(eq(servers.hostKeyStatus, "pending"));
    for (const server of pending) {
      try {
        const offered = await this.#ssh.probe(server);
        await db
          .update(servers)
          .set({
            hostKeyStatus: "awaiting_validation",
            offeredFingerprint: offered.fingerprint,
            offeredAlgorithm: offered.algorithm,
            updatedAt: sql`now()`,
          })
          .where(and(eq(servers.id, server.id), eq(servers.hostKeyStatus, "pending")));
      } catch (error) {
        this.#deps.log.warn(
          { serverId: server.id, err: (error as Error).message },
          "clé d'hôte illisible",
        );
        await db
          .update(servers)
          .set({ hostKeyStatus: "unreachable", updatedAt: sql`now()` })
          .where(eq(servers.id, server.id));
      }
    }
    return pending.length;
  }
}
