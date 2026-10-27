import { parse } from "yaml";

// G5.11 — dépendances vulnérables, quand le lockfile a changé. On compare les paquets avant et
// après, puis on interroge la base OSV (api.osv.dev) pour les seuls paquets ajoutés ou modifiés.

export type Package = { ecosystem: "npm" | "PyPI"; name: string; version: string };

export function parsePackageLock(text: string): Package[] {
  const json = JSON.parse(text) as {
    packages?: Record<string, { version?: string; link?: boolean }>;
  };
  return Object.entries(json.packages ?? {})
    .filter(([path, info]) => path.includes("node_modules/") && info.version && !info.link)
    .map(([path, info]) => ({
      ecosystem: "npm" as const,
      name: path.slice(path.lastIndexOf("node_modules/") + 13),
      version: info.version as string,
    }));
}

export function parsePnpmLock(text: string): Package[] {
  const lock = (parse(text, { maxAliasCount: 100 }) ?? {}) as {
    packages?: Record<string, unknown>;
  };
  return Object.keys(lock.packages ?? {}).flatMap((key) => {
    // `/nom@1.2.3`, `nom@1.2.3`, `@scope/nom@1.2.3(peer@x)`
    const match = /^\/?((?:@[^/]+\/)?[^@/(]+)@([^(@]+)/.exec(key);
    return match?.[1] && match[2]
      ? [{ ecosystem: "npm" as const, name: match[1], version: match[2] }]
      : [];
  });
}

export function parseRequirements(text: string): Package[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([A-Za-z0-9_.+-]+)/.exec(line);
    return match?.[1] && match[2]
      ? [{ ecosystem: "PyPI" as const, name: match[1].toLowerCase(), version: match[2] }]
      : [];
  });
}

export const LOCKFILES: Record<string, (text: string) => Package[]> = {
  "package-lock.json": parsePackageLock,
  "pnpm-lock.yaml": parsePnpmLock,
  "requirements.txt": parseRequirements,
};

export function lockfileParser(path: string): ((text: string) => Package[]) | undefined {
  return LOCKFILES[path.split("/").at(-1) ?? ""];
}

/** Paquets ajoutés ou dont la version a changé. */
export function changedPackages(before: readonly Package[], after: readonly Package[]): Package[] {
  const known = new Set(before.map((p) => `${p.ecosystem}:${p.name}@${p.version}`));
  const seen = new Set<string>();
  return after.filter((p) => {
    const key = `${p.ecosystem}:${p.name}@${p.version}`;
    if (known.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";
export type Vulnerability = { id: string; package: Package; severity: Severity; summary: string };

type OsvVuln = {
  id: string;
  summary?: string;
  database_specific?: { severity?: string };
  severity?: { type: string; score: string }[];
};

export function severityOf(vuln: OsvVuln): Severity {
  const label = vuln.database_specific?.severity?.toLowerCase();
  if (label === "moderate") return "medium";
  if (label === "low" || label === "medium" || label === "high" || label === "critical")
    return label;
  return "unknown";
}

/** Interroge OSV par lots ; seuls les paquets vulnérables donnent lieu à une requête de détail. */
export async function queryOsv(
  packages: readonly Package[],
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Vulnerability[]> {
  if (packages.length === 0) {
    return [];
  }
  const baseUrl = options.baseUrl ?? "https://api.osv.dev";
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: Vulnerability[] = [];
  for (let i = 0; i < packages.length; i += 500) {
    const chunk = packages.slice(i, i + 500);
    const response = await fetchImpl(`${baseUrl}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: chunk.map((p) => ({
          package: { ecosystem: p.ecosystem, name: p.name },
          version: p.version,
        })),
      }),
    });
    if (!response.ok) {
      throw new Error(`OSV a répondu ${response.status}`);
    }
    const batch = (await response.json()) as { results: { vulns?: { id: string }[] }[] };
    for (const [index, result] of batch.results.entries()) {
      for (const { id } of result.vulns ?? []) {
        const detail = await fetchImpl(`${baseUrl}/v1/vulns/${encodeURIComponent(id)}`);
        const vuln = (detail.ok ? await detail.json() : { id }) as OsvVuln;
        results.push({
          id,
          package: chunk[index] as Package,
          severity: severityOf(vuln),
          summary: vuln.summary ?? "",
        });
      }
    }
  }
  return results;
}
