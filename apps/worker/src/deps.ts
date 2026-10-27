import type { Language } from "@jules/config";
import type { Db } from "@jules/db";
import type { GitHubApp } from "@jules/forge";
import type { Logger } from "pino";
import type { PlanService } from "./devops/plans.js";

export type WorkerSettings = {
  readonly mention: string;
  readonly label: string;
  readonly language: Language;
};

export type WorkerDeps = {
  readonly db: Db;
  readonly github: GitHubApp;
  readonly log: Logger;
  readonly settings: WorkerSettings;
  /** Arrêt d'urgence déclenché depuis GitHub (`/jules stop-all`, admin seulement). */
  readonly emergency?: { stopAll(actorId: string): Promise<object> };
  /** Plafond global du budget d'une tâche, pour `/jules budget`. */
  readonly taskBudgetCapUsd?: number;
  /** Plans de changement DevOps (M7) : approbation depuis GitHub et le web. */
  readonly plans?: PlanService;
};
