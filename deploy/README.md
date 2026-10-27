# Déployer Jules

Ce guide met en service Jules sur un hôte Linux, avec la GitHub App installée sur un repo bac à sable. À la fin, un commentaire `@jules` dans une issue reçoit un commentaire de statut. La vue d'ensemble est dans le [guide d'administration](../docs/guide-admin.md).

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

## 2. Installation en une commande

```bash
sudo deploy/install.sh --domain jules.example.org --admins alice,bob --systemd
```

Le script vérifie l'hôte (Docker 28+, gVisor, dossier des exécutions), crée `deploy/secrets/` (mode 600, jamais versionné) : mot de passe PostgreSQL, secret de webhook, mot de passe restic et **clé maître**. Il crée `deploy/.env` et `deploy/backup.env`, y reporte les options données, construit les images, démarre la pile (sans le worker tant que la GitHub App n'est pas créée) et active les timers de sauvegarde (`--systemd`). Il est relançable : ce qui existe est gardé. `deploy/install.sh --help` liste les options ; `--no-start` prépare sans démarrer.

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
4. pour la connexion à l'interface web, la même App sert de fournisseur OAuth :
   - *Callback URL* : `https://<domaine>/v1/auth/github/callback` ;
   - note le **Client ID** dans `deploy/.env` (`GITHUB_OAUTH_CLIENT_ID=`) ;
   - génère un **client secret** et range-le dans `deploy/secrets/github_oauth_client_secret` (mode 600) ;
   - mets ton login GitHub dans `JULES_ADMIN_LOGINS` (séparés par des virgules). Les autres personnes sont ajoutées ensuite comme membres, avec un rôle Jules.

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

**Instance personnelle avec un abonnement Claude** (Pro ou Max) au lieu d'une clé API : Anthropic réserve ce jeton à l'usage de la personne abonnée, jamais à une équipe ni à un service offert à d'autres. Crée-le sur ton poste avec `claude setup-token` (valable un an), puis :

```bash
docker compose run --rm -T worker node dist/cli.js secrets set claude_oauth_token < claude.token
shred -u claude.token
# dans deploy/.env :
JULES_MODEL_AUTH=subscription
```

Le broker l'envoie au fournisseur comme le fait Claude Code avec un abonnement (en-tête `Authorization`, bêta `oauth-2025-04-20`). Quand l'abonnement atteint sa limite, les tâches passent en `waiting_provider` jusqu'à l'heure de reprise annoncée par le fournisseur, sans échouer. Les budgets en dollars restent des plafonds, calculés au prix de l'API.

## 5. Démarrer

```bash
docker compose --profile caddy up -d     # avec un domaine (renseigne JULES_DOMAIN)
docker compose --profile tunnel up -d    # ou avec Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN)
docker compose logs -f worker
```

Le webhook va au gateway, l'interface web et `/v1` vont à l'api : rien d'autre n'est exposé. Au démarrage, le worker redemande à GitHub les webhooks des trois derniers jours qui ne sont pas en base.

Première connexion : ouvre `https://<domaine>`, connecte-toi avec GitHub, puis ajoute une **passkey** dans *Réglages*. Sans passkey, aucune action sensible n'est possible depuis l'interface (relever l'autonomie, écrire un secret, lever l'arrêt d'urgence).

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

## 8. Serveurs pour l'agent DevOps

Sur chaque serveur, crée un utilisateur dédié (par exemple `jules`), avec un `sudo` limité aux commandes utiles et sans mot de passe (`sudo -n`) :

```bash
sudo adduser --disabled-password jules
echo 'jules ALL=(root) NOPASSWD: /usr/bin/systemctl restart app, /usr/bin/docker' | sudo tee /etc/sudoers.d/jules
```

Puis, dans l'interface (*Serveurs*, admin, passkey) :
1. **Enregistrer** le serveur : nom, hôte, utilisateur, environnement, repo déployé, et la **clé privée** SSH. Elle est scellée pour le worker dès réception et n'est plus jamais affichée.
2. Le worker lit la **clé d'hôte** et l'affiche. Compare-la à la sortie de `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` sur le serveur, puis **valide** l'empreinte. Si elle change plus tard, le serveur est bloqué jusqu'à une nouvelle validation.
3. Choisis le **niveau** : D0 (lecture seule) par défaut, D1 (tout changement passe par un plan approuvé), D2 (playbooks directs hors production), D3 (commandes directes hors production). La production exige toujours une approbation humaine avec passkey.

Pour le pipeline de déploiement, le repo déclare dans `.jules/config.yml` :

```yaml
deploy:
  staging: { server: web-staging, playbook: deploy }
  production: { server: web-prod, playbook: deploy }
```

et dans `.jules/playbooks.yml` un playbook `deploy` avec ses paramètres typés (`ref: { type: git_sha, required: true }`), ses étapes, une vérification (`verify`) et un retour arrière (`rollback`, qui peut utiliser `{{previous_ref}}`). Un playbook sans vérification ou sans retour arrière n'est pas déployé. Chaque PR mergée sur la branche par défaut, CI verte, part en staging ; la production attend ensuite une approbation dans l'interface.

Les réglages *quatre yeux* et *approbation de la production depuis GitHub* sont dans *Réglages* (admin, passkey). Les deux sont coupés par défaut.

Si le worker s'arrête pendant un plan, le plan passe en `interrupted` au redémarrage et rien n'est relancé : regarde le journal des étapes du plan, vérifie l'état du serveur, puis relance la tâche (`/jules retry`) pour un nouveau diagnostic.

### Agent Sécurité

Chaque semaine, et à chaque merge sur la branche par défaut, Jules audite les repos, les serveurs validés et sa propre config. La page *Sécurité* liste les findings et leurs échéances (critique 7 jours, haut 30, moyen 90). Un finding critique ou haut ouvert bloque les playbooks `deploy*` de sa cible, jusqu'à sa correction ou une décision humaine : *accepter le risque* (passkey et échéance de moins d'un an) ou *confirmer un faux positif*. Par défaut, l'agent est en **S0** (il audite) ; passe-le en **S1** dans *Réglages* pour qu'il propose des tâches de remédiation. Les repos privés reçoivent les failles du code en SARIF (onglet Security) et des issues `security` ; rien n'est publié pour un repo public, ni pour un serveur.

## 9. Sauvegardes

Deux mécanismes, chiffrés par restic et envoyés hors de l'hôte (M11) :
- **chaque nuit**, une copie logique (`pg_dump`, portable d'une version de PostgreSQL à l'autre) et une copie physique (`pg_basebackup`) ;
- **en continu**, les WAL : PostgreSQL archive chaque segment dans le volume de la base au plus tard toutes les 5 minutes (`archive_timeout`), et `jules-wal.timer` les envoie toutes les 5 minutes. Perte maximale : environ 10 minutes.

1. Renseigne le dépôt restic hors de l'hôte dans `deploy/backup.env` (S3, B2, SFTP…).
2. Active les deux timers (`install.sh --systemd` le fait) :

   ```bash
   sudo cp deploy/systemd/jules-backup.* deploy/systemd/jules-wal.* /etc/systemd/system/
   sudo systemctl enable --now jules-backup.timer jules-wal.timer
   sudo systemctl start jules-backup.service   # première sauvegarde tout de suite
   ```

3. Teste une restauration. C'est à refaire avant le pilote, puis chaque mois :

   ```bash
   deploy/restore-test.sh
   ```

   Le script restaure la dernière sauvegarde dans une base jetable. Il vérifie ensuite les migrations, la chaîne d'audit et le déchiffrement de chaque secret, puis supprime la base.

4. **Revenir à un instant donné** (une erreur humaine, une montée de version ratée). L'instant est en UTC ; la restauration se fait dans un volume neuf, l'ancien reste intact :

   ```bash
   docker compose stop api gateway worker postgres
   docker volume create jules_pgdata_restaure
   docker compose --profile ops run --rm -v jules_pgdata_restaure:/var/lib/postgresql \
     --entrypoint restore-pitr.sh backup '2026-10-27 14:30:00'
   ```

   Pointe ensuite le service `postgres` sur ce volume (`volumes:` de `compose.yaml`, ou renomme les volumes), puis `docker compose up -d` : PostgreSQL rejoue les WAL jusqu'à l'instant, puis reprend normalement. Vérifie avec `audit verify` et `secrets verify`, et fais une sauvegarde complète tout de suite (`systemctl start jules-backup.service`) : c'est le nouveau point de départ. La procédure est testée de bout en bout (`apps/worker/test/pitr.test.ts`).

## 10. Opérations courantes

Toutes les commandes passent par le CLI du worker : `docker compose run --rm worker node dist/cli.js <commande>`.

| Commande | Usage |
|---|---|
| `audit verify` | vérifie la chaîne du journal d'audit ; code de sortie 2 si elle est rompue |
| `reconcile --hours 72` | redemande les webhooks manqués, sans attendre le passage automatique (toutes les 10 min) |
| `secrets verify` | vérifie que chaque secret se déchiffre |
| `master-key fingerprint` | affiche l'empreinte de la clé maître, à comparer avec la copie de secours |
| `stop --all [--reason …]` | **arrêt d'urgence** : bloque tout nouveau démarrage, révoque les jetons, tue tous les sandboxes ; marche même si l'api est tombée |
| `stop --lift` | lève l'arrêt d'urgence |
| `migrate` | applique les migrations et affiche celles de la base ; l'api, le gateway et le worker refusent de démarrer sur une base en retard ou plus récente que leur code |
| `audit self --osv https://api.osv.dev` | audit de Jules par ses propres scanners (secrets, dépendances, infra) ; code 1 si un finding critique ou haut est ouvert ou si un risque accepté a expiré (`security/exceptions.json`) |

### Montée de version

```bash
deploy/upgrade.sh v1.0.1
```

Sauvegarde complète d'abord (sans elle, rien ne change), puis le code du tag, les images, l'arrêt du worker, de l'api et du gateway, les migrations (dans une transaction), le redémarrage, et enfin `audit verify` et `secrets verify`. Les webhooks reçus pendant l'arrêt sont rattrapés par la réconciliation. En cas d'échec, reviens au tag précédent et, si des migrations ont été appliquées, restaure l'instant d'avant (§9, étape 4).

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

## 11. Mode local (app desktop)

En mode local, l'app desktop lance elle-même `deploy/local/compose.yaml` (embarqué dans l'app) : PostgreSQL, l'api et le worker, avec les images du serveur. Il n'y a ni GitHub App ni domaine ; rien n'est à configurer à la main. Ce qui suit sert au diagnostic.

- **Moteur** : Docker (Docker Engine sous Linux, Docker Desktop sous macOS et Windows avec WSL 2) ou Podman. L'app lit `docker info`, puis `podman info`, et propose l'installation si aucun ne répond. Le pilote des sandboxes n'est vérifié qu'avec Docker : Podman est détecté, mais son réseau interne isolé reste à valider.
- **Isolation** : gVisor si `runsc` figure parmi les runtimes de Docker (Linux), sinon la VM de Docker Desktop, sinon un conteneur ordinaire. L'app l'affiche en permanence. Pour un repo sensible, préfère un serveur Jules.
- **Images** : l'app lance les images de sa propre version (`jules-api:0.1.0` pour l'app 0.1.0, etc.). Tant qu'elles ne sont pas publiées, construis-les depuis le repo, une fois par version de l'app : `deploy/local/build-images.sh` (version de `apps/desktop/package.json`, ou celle passée en argument). Sans elles, l'app affiche « Images Jules … introuvables ».
- **Secrets** : la clé maître et le secret de connexion de l'app sont tirés au premier lancement et rangés dans le trousseau du système (service `jules-desktop`, entrées `local:master-key` et `local:login-secret`), de même que l'accès au modèle demandé par l'app au premier démarrage, un seul à la fois : le jeton de ton abonnement Claude (`claude setup-token`, entrée `local:claude-subscription-token`, usage personnel) ou une clé API (entrée `local:anthropic-api-key`), et la clé qui signe les confirmations des actions sensibles (entrée `local:step-up-key` ; l'api locale ne reçoit que sa clé publique). Aucun fichier ne les contient ; l'environnement des conteneurs non plus. La clé maître et l'accès au modèle sont remis au worker une fois par démarrage, sur un socket `$XDG_RUNTIME_DIR/jules/handoff-<id>.sock` propre à chaque démarrage (Linux) ou une adresse de bouclage (Docker Desktop) : un worker arrêté est relancé par l'app, pas par Docker. L'accès au modèle ne passe ni par la base ni par une passkey ; il se remplace dans **Réglages → Accès au modèle**, ce qui relance le worker.
- **Dossiers** : le dossier personnel est monté au même chemin dans le worker (`JULES_LOCAL_ROOT` pour en choisir un autre), avec les droits de la personne. Sous Windows, les chemins passent par `/run/desktop/mnt/host/<lecteur>`, la convention de Docker Desktop avec WSL 2.
- **Arrêter, repartir de zéro** : `docker compose -p jules-local stop` garde les données ; `docker compose -p jules-local down -v` efface la base locale. Supprimer les entrées du trousseau rend illisibles les secrets chiffrés de cette base.
