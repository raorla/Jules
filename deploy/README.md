# Déployer Jules (M0)

Ce guide met en service le gateway et le worker sur un hôte Linux, avec la GitHub App installée sur un repo bac à sable. À la fin, un commentaire `@jules` dans une issue reçoit un commentaire de statut.

Ce qui tourne : `postgres`, `migrate` (une fois au démarrage), `gateway`, `worker`, et au choix `caddy` ou `cloudflared` pour exposer le gateway en TLS. Depuis M1, le worker lance un sandbox gVisor et un egress proxy par exécution.

## 1. Prérequis

- Un hôte Linux avec Docker et le plugin compose.
- Un nom de domaine (avec Caddy) ou un tunnel Cloudflare.
- Le repo Jules copié dans `/opt/jules` (le timer de sauvegarde suppose ce chemin).
- Docker 28 ou plus récent : le réseau de chaque exécution utilise `gateway_mode_ipv4=isolated`, qui coupe toute route vers l'hôte.
- gVisor, déclaré comme runtime Docker. Le broker est joint par un socket Unix monté dans le sandbox : gVisor doit l'autoriser (`--host-uds=open`).

  ```bash
  # https://gvisor.dev/docs/user_guide/install/ (dépôt apt), puis :
  sudo runsc install -- --host-uds=open
  sudo systemctl restart docker
  docker run --rm --runtime=runsc hello-world
  ```

- Le dossier des exécutions, possédé par l'utilisateur 1000 (celui du worker et des sandboxes) :

  ```bash
  sudo install -d -o 1000 -g 1000 -m 700 /var/lib/jules/runs
  ```

## 2. Secrets locaux

```bash
deploy/install.sh
```

Le script crée `deploy/secrets/` (mode 600, jamais versionné) : mot de passe PostgreSQL, secret de webhook, mot de passe restic et **clé maître**. Il crée aussi `deploy/.env` et `deploy/backup.env`.

Range tout de suite une copie de `jules_master_key` et de `restic_password` **hors de la machine** (gestionnaire de mots de passe ou papier), avec l'empreinte affichée. Sans la clé maître, les secrets d'une sauvegarde sont perdus. Sans le mot de passe restic, les sauvegardes sont illisibles.

## 3. Créer la GitHub App

Sur GitHub : *Settings → Developer settings → GitHub Apps → New GitHub App* (ou les réglages de l'organisation).

| Champ | Valeur |
|---|---|
| Webhook URL | `https://<domaine>/webhooks/github` |
| Webhook secret | le contenu de `deploy/secrets/github_webhook_secret` |
| Où l'installer | *Only on this account* |

Permissions de repo, exactement celles-ci ([ARCHITECTURE.md §12](../ARCHITECTURE.md#12-intégration-github)) :

| Permission | Niveau |
|---|---|
| Metadata | Read-only |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Checks | Read and write |
| Deployments | Read and write |
| Code scanning alerts | Read and write |
| **Workflows** | **No access** |

Événements : `Issues`, `Issue comment`, `Pull request`, `Pull request review`, `Pull request review comment`, `Check suite`, `Push`.

Le worker relit ces réglages à chaque démarrage. Il **refuse de démarrer** si l'App a la permission `workflows` (ou `administration`, `secrets`, `actions`, `environments`) et signale dans ses logs une permission ou un événement manquant.

Ensuite :
1. note l'**App ID** dans `deploy/.env` (`GITHUB_APP_ID=`) ;
2. génère une **clé privée** (fichier `.pem`) ;
3. choisis la mention qui déclenche Jules (`JULES_MENTION` dans `deploy/.env`). `@jules` notifie aussi le compte GitHub public du même nom : préfère le nom de ton App, par exemple `@jules-mtonga`.

## 4. Enregistrer les clés, chiffrées

```bash
cd deploy
docker compose build
docker compose --profile images build          # images du sandbox et de l'egress proxy
docker compose run --rm -T worker node dist/cli.js secrets set github_app_private_key < ~/Téléchargements/jules.private-key.pem
shred -u ~/Téléchargements/jules.private-key.pem
# Clé d'un compte Anthropic dédié à Jules, avec une limite de dépense dans la console :
docker compose run --rm -T worker node dist/cli.js secrets set anthropic_api_key < anthropic.key
shred -u anthropic.key
```

Les clés sont chiffrées par la clé maître avant d'entrer en base. Elles n'existent plus en clair nulle part, et n'entrent jamais dans un sandbox : le broker remplace le jeton d'exécution par la vraie clé.

## 5. Démarrer

```bash
docker compose --profile caddy up -d     # avec un domaine (renseigne JULES_DOMAIN)
docker compose --profile tunnel up -d    # ou avec Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN)
docker compose logs -f worker
```

Seule la route `/webhooks/github` est exposée. Au démarrage, le worker redemande à GitHub les webhooks des trois derniers jours qui ne sont pas en base.

## 6. Essai sur le repo bac à sable

1. Installe l'App sur le repo bac à sable (page de l'App → *Install App*).
2. Dans une issue, commente `@jules ajoute un endpoint /healthz` (avec ta mention).
3. Jules répond par un commentaire de statut « reçue ». Il faut un droit `write` sur le repo : le commentaire d'un simple lecteur est ignoré et journalisé.

## 7. Mettre un repo sous Jules

Dans une issue du repo, une personne avec le droit `maintain` commente `@jules setup` (avec ta mention). Jules ouvre une PR qui contient trois choses :
- une `.jules/config.yml` adaptée à la stack détectée (Node, Python, Go ou Rust) ;
- un `AGENTS.md`, s'il n'existe ni `AGENTS.md` ni `CLAUDE.md` ;
- des CODEOWNERS pour les chemins sensibles.

La PR liste aussi les règles de branche qui manquent. Relis les commandes avant de merger : Jules lit sa config sur la branche par défaut.

Règles recommandées sur la branche par défaut (*Settings → Rules → Rulesets*) ([ARCHITECTURE.md §12](../ARCHITECTURE.md#rulesets-recommandés-sur-chaque-repo)) :
- **Require a pull request before merging**, avec au moins une approbation et **Require review from Code Owners** ;
- **Require status checks to pass** : `Jules / gates`, `Jules / review`, et la CI du projet ;
- **Block force pushes** ;
- Jules ne figure pas dans la liste de bypass.

La review de Jules est publiée en COMMENT : elle ne compte jamais comme une approbation.

## 8. Sauvegardes

1. Renseigne le dépôt restic hors de l'hôte dans `deploy/backup.env` (S3, B2, SFTP…).
2. Active la sauvegarde quotidienne :

   ```bash
   sudo cp deploy/systemd/jules-backup.* /etc/systemd/system/
   sudo systemctl enable --now jules-backup.timer
   sudo systemctl start jules-backup.service   # première sauvegarde tout de suite
   ```

3. Teste une restauration. C'est à refaire avant le pilote, puis chaque mois :

   ```bash
   deploy/restore-test.sh
   ```

   Le script restaure la dernière sauvegarde dans une base jetable. Il vérifie ensuite les migrations, la chaîne d'audit et le déchiffrement de chaque secret, puis supprime la base.

## 9. Opérations courantes

Toutes les commandes passent par le CLI du worker : `docker compose run --rm worker node dist/cli.js <commande>`.

| Commande | Usage |
|---|---|
| `audit verify` | vérifie la chaîne du journal d'audit ; code de sortie 2 si elle est rompue |
| `reconcile --hours 72` | redemande les webhooks manqués, sans attendre le passage automatique (toutes les 10 min) |
| `secrets verify` | vérifie que chaque secret se déchiffre |
| `master-key fingerprint` | affiche l'empreinte de la clé maître, à comparer avec la copie de secours |
| `stop --all [--reason …]` | **arrêt d'urgence** : bloque tout nouveau démarrage, révoque les jetons, tue tous les sandboxes ; marche même si l'api est tombée |
| `stop --lift` | lève l'arrêt d'urgence |

### Rotation de la clé maître

1. `cp secrets/jules_master_key secrets/jules_master_key.old`, puis `openssl rand -base64 32 > secrets/jules_master_key`.
2. Rechiffre les secrets avec la nouvelle clé :

   ```bash
   JULES_MASTER_KEY_PREVIOUS="$(cat secrets/jules_master_key.old)" \
     docker compose run --rm -e JULES_MASTER_KEY_PREVIOUS worker node dist/cli.js secrets rotate
   ```

3. `docker compose restart worker`, puis `secrets verify`.
4. Remplace la copie de secours, puis supprime `jules_master_key.old` (`shred -u`).

Seules les clés de données sont rechiffrées, jamais les valeurs. Les sauvegardes antérieures restent liées à l'ancienne clé : garde sa copie de secours tant qu'elles existent (6 mois).

### Rotation de la clé de la GitHub App

Génère une nouvelle clé sur la page de l'App, enregistre-la avec `secrets set github_app_private_key` (étape 4), redémarre le worker, puis supprime l'ancienne clé sur GitHub.

### Rotation du secret de webhook

Génère un nouveau secret dans `secrets/github_webhook_secret`, recopie-le dans les réglages de l'App, puis `docker compose restart gateway`. Les livraisons refusées pendant le changement sont rattrapées par la réconciliation.
