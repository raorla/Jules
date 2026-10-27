// Lecture du diff et de l'historique produits par git sur le pristine du worker. Pur : on lui
// passe la sortie de `git diff -U0` et de `git log`, il renvoie une structure exploitable.

export type AddedLine = { line: number; text: string };
export type FileDiff = {
  path: string;
  /** A ajouté, M modifié, D supprimé (les renommages sont vus comme suppression + ajout). */
  status: "A" | "M" | "D";
  added: AddedLine[];
  removed: string[];
};

/** Parse la sortie de `git diff -U0 --no-renames --no-color --no-ext-diff base head`. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let nextLine = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(raw);
      current = { path: match?.[1] ?? "", status: "M", added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (raw.startsWith("new file mode")) {
      current.status = "A";
    } else if (raw.startsWith("deleted file mode")) {
      current.status = "D";
    } else if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
      // en-têtes de fichier
    } else if (raw.startsWith("@@")) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(raw);
      nextLine = Number(match?.[1] ?? 0);
    } else if (raw.startsWith("+")) {
      current.added.push({ line: nextLine, text: raw.slice(1) });
      nextLine += 1;
    } else if (raw.startsWith("-")) {
      current.removed.push(raw.slice(1));
    }
  }
  return files;
}

export type Commit = { sha: string; subject: string; body: string };

/** Séparateurs de `git log --format=%H%x1f%s%x1f%b%x1e`. */
export const COMMIT_LOG_FORMAT = "%H%x1f%s%x1f%b%x1e";

export function parseCommitLog(text: string): Commit[] {
  return text
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => {
      const [sha = "", subject = "", body = ""] = entry.split("\x1f");
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    });
}

export function diffStats(files: readonly FileDiff[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.added.length, 0),
    deletions: files.reduce((n, f) => n + f.removed.length, 0),
  };
}
