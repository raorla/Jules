# Jules desktop

L'app desktop de Jules (Tauri 2), en mode connecté : la même interface que le web (`packages/ui`), plus la connexion par le navigateur du système (OAuth avec PKCE, RFC 8252), le jeton rangé dans le trousseau, les notifications natives, la barre système et l'ouverture d'un dossier local dans l'éditeur. Voir [ARCHITECTURE.md §4.7](../../ARCHITECTURE.md#47-app-desktop-appsdesktop).

| Dossier | Contenu |
|---|---|
| `src/` | entrée de l'interface et pont vers le shell (`bridge.ts`) |
| `src-tauri/` | shell Tauri : trousseau, connexion, notifications, barre système, mises à jour |
| `core/` | logique sans Tauri, testée partout : PKCE, retour de l'OAuth, compatibilité, signatures |
| `e2e/` | l'interface desktop dans un navigateur, avec un pont simulé et la vraie api |

## Développer

Sous Linux, Tauri demande les en-têtes de WebKitGTK :

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential
```

```bash
pnpm --filter @jules/desktop tauri dev           # l'app, branchée sur Vite
cargo test --manifest-path apps/desktop/core/Cargo.toml
pnpm --filter @jules/desktop e2e                 # connexion, version trop ancienne, notification
```

## Publier une version signée

1. **Clé des mises à jour**, une fois : `pnpm --filter @jules/desktop tauri signer generate -w ~/.tauri/jules.key`. Recopie la clé publique dans `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) et l'adresse du dépôt dans `endpoints`. L'app refuse toute mise à jour qui n'est pas signée par cette clé.
2. **Secrets du dépôt GitHub** :
   - `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ;
   - macOS (Apple Developer) : `APPLE_CERTIFICATE` (p12 en base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (mot de passe d'app), `APPLE_TEAM_ID`, pour la signature et la notarisation ;
   - Windows : `WINDOWS_CERTIFICATE` (pfx en base64) et `WINDOWS_CERTIFICATE_PASSWORD`, plus l'empreinte du certificat dans `bundle.windows.certificateThumbprint`.
3. **Étiquette** : `git tag desktop-v0.2.0 && git push --tags` (avec la même version dans `tauri.conf.json` et `package.json`). La CI construit l'AppImage, le deb et le rpm, le MSI, et le dmg universel, les publie, puis écrit `latest.json`, que l'app installée lit au démarrage.

## Compatibilité avec le serveur

`/v1/health` publie `desktop.minVersion`. Une app plus ancienne affiche « Mise à jour requise » au lieu de se connecter. Relève ce minimum dans `apps/api/src/app.ts` quand l'api cesse d'accepter une ancienne version.
