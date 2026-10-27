// Manifeste des mises à jour (`latest.json`) lu par le plugin updater de Tauri. Chaque plateforme
// pointe vers son paquet et porte sa signature minisign ; sans signature valide, l'app refuse.

export type ReleaseFile = { readonly name: string; readonly signature?: string };

export type LatestJson = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/** Paquet de mise à jour de chaque plateforme, tel que produit par `tauri build`. */
const UPDATER_ARTIFACTS: [RegExp, string[]][] = [
  [/_amd64\.AppImage$/, ["linux-x86_64"]],
  [/_x64_[a-z]{2}-[A-Z]{2}\.msi$/, ["windows-x86_64"]],
  [/_universal\.app\.tar\.gz$|\.app\.tar\.gz$/, ["darwin-aarch64", "darwin-x86_64"]],
];

export function latestJson(
  files: readonly ReleaseFile[],
  release: { version: string; baseUrl: string; notes: string; date: Date },
): LatestJson {
  const platforms: LatestJson["platforms"] = {};
  for (const file of files) {
    const match = UPDATER_ARTIFACTS.find(([pattern]) => pattern.test(file.name));
    if (!match || !file.signature) {
      continue;
    }
    for (const platform of match[1]) {
      platforms[platform] = {
        signature: file.signature.trim(),
        url: `${release.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(file.name)}`,
      };
    }
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error("aucun paquet signé : la mise à jour ne serait pas installable");
  }
  return {
    version: release.version,
    notes: release.notes,
    pub_date: release.date.toISOString(),
    platforms,
  };
}
