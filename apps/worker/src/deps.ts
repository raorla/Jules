import type { Language } from "@jules/config";
import type { Db } from "@jules/db";
import type { GitHubApp } from "@jules/forge";
import type { Logger } from "pino";

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
};
