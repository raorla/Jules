import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Prompts versionnés (WORKFLOW.md §11) : `prompts/<rôle>/vN.md`. Le worker prend la version la plus
// haute ; les précédentes restent dans le repo, pour les evals (`jules eval compare`) et pour revenir
// en arrière. Chaque exécution enregistre la version jouée (`runs.prompt_version`).
export async function latestPromptVersion(promptsDir: string, role: string): Promise<number> {
  const versions = (await readdir(join(promptsDir, role)))
    .map((file) => /^v([1-9]\d*)\.md$/.exec(file)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number);
  if (versions.length === 0) {
    throw new Error(`aucun prompt pour le rôle ${role} dans ${promptsDir}`);
  }
  return Math.max(...versions);
}
