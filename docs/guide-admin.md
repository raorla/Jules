# Guide d'administration de Jules

Ce guide s'adresse à la personne qui installe et fait tourner un serveur Jules. Les commandes détaillées, étape par étape, sont dans [deploy/README.md](../deploy/README.md) ; l'architecture et ses raisons dans [ARCHITECTURE.md](../ARCHITECTURE.md). Pour utiliser Jules : [guide d'utilisation](guide-utilisateur.md).

## 1. Ce qui tourne

| Service | Rôle | Secrets reçus |
|---|---|---|
| `postgres` | état, file de travail, audit, secrets chiffrés ; WAL archivés en continu | mot de passe de la base |
| `migrate` | applique les migrations au démarrage, puis s'arrête | URL de la base |
| `gateway` | reçoit les webhooks GitHub (HMAC vérifié) | secret de webhook |
| `api` | interface web et desktop (OAuth GitHub, passkeys) | client secret OAuth |
| `worker` | agents, sandboxes gVisor, SSH vers les serveurs, effets GitHub | clé maître (déchiffre les autres en mémoire) |
| `caddy` ou `cloudflared` | exposition TLS | jeton du tunnel le cas échéant |
| `backup` (timers) | sauvegardes chiffrées hors de l'hôte | mots de passe de la base et de restic |

L'hôte doit être dédié : le worker pilote Docker pour créer les sandboxes (risque accepté et documenté dans `security/exceptions.json`).

## 2. Installer en une commande

Prérequis : Linux, Docker 28 ou plus récent avec le plugin compose, gVisor déclaré comme runtime (`runsc install -- --host-uds=open`), le repo dans `/opt/jules`, un domaine ou un tunnel Cloudflare.

```bash
sudo deploy/install.sh --domain jules.example.org --admins alice,bob --systemd
```

Le script vérifie l'hôte (Docker, gVisor), crée les secrets locaux (`deploy/secrets/`, mode 600), remplit `deploy/.env`, construit les images, démarre la pile sans le worker et active les timers de sauvegarde. Il est relançable : ce qui existe est gardé.

**Range tout de suite hors de la machine** la clé maître (`deploy/secrets/jules_master_key`) et le mot de passe restic, avec l'empreinte affichée. Sans eux, une sauvegarde est inutilisable.

Ensuite :
1. crée la GitHub App ([deploy/README.md §3](../deploy/README.md#3-créer-la-github-app)) et enregistre sa clé et la clé API du fournisseur (ou, pour une instance personnelle, le jeton de ton abonnement Claude avec `JULES_MODEL_AUTH=subscription`), chiffrées ([§4](../deploy/README.md#4-enregistrer-les-clés-chiffrées)) ;
2. renseigne le dépôt des sauvegardes dans `deploy/backup.env` ;
3. `sudo deploy/install.sh --github-app-id <n>` démarre le worker ;
4. essaie sur un repo bac à sable ([§6](../deploy/README.md#6-essai-sur-le-repo-bac-à-sable)), puis mets tes repos sous Jules en L0.

## 3. Sauvegardes et restauration

| Quoi | Quand | Où |
|---|---|---|
| WAL archivés par PostgreSQL | au plus tard toutes les 5 minutes | volume de la base, puis restic (`jules-wal.timer`, toutes les 5 minutes) |
| Copie physique (`pg_basebackup`) | chaque nuit | restic |
| Copie logique (`pg_dump`) | chaque nuit | restic |

Perte maximale en cas de sinistre : environ 10 minutes. La clé maître n'est jamais dans une sauvegarde.

- **Vérifier une sauvegarde** (chaque mois) : `deploy/restore-test.sh` restaure la dernière copie logique dans une base jetable, puis vérifie les migrations, le journal d'audit et les secrets.
- **Revenir à un instant donné** (erreur humaine, montée de version ratée) : `restore-pitr.sh '<AAAA-MM-JJ HH:MM:SS>'` (heure UTC) prépare un volume neuf à partir de la copie physique et des WAL ; PostgreSQL, démarré dessus, rejoue jusqu'à cet instant. Procédure complète : [deploy/README.md §9](../deploy/README.md#9-sauvegardes).
- **Reprise sur une machine neuve** : installe Jules (§2), remets la clé maître et le mot de passe restic dans `deploy/secrets/`, restaure (copie physique ou logique), puis `docker compose up -d`.

## 4. Monter de version

```bash
deploy/upgrade.sh v1.0.1
```

Dans cet ordre : sauvegarde complète (sans elle, rien ne change), code du tag, images, arrêt du worker, de l'api et du gateway, migrations dans une transaction, redémarrage, vérification du journal d'audit et des secrets. Les webhooks reçus pendant l'arrêt sont redemandés à GitHub par la réconciliation.

Garde-fous :
- les migrations sont additives ; une migration destructive doit le dire (`-- jules: destructif accepté : …`), sinon un test la refuse ;
- l'api, le gateway et le worker refusent de démarrer sur une base en retard (`jules migrate`) ou plus récente que leur code (retour arrière mal fait) ;
- en cas d'échec, reviens à la version précédente et, si des migrations ont été appliquées, restaure l'instant d'avant la montée de version.

## 5. Sécurité de l'instance

- **Audit de Jules lui-même** : `docker compose run --rm worker node dist/cli.js audit self --osv https://api.osv.dev` passe le code, les dépendances et la config d'infra de Jules dans les scanners de l'agent Sécurité. Code 1 si un finding critique ou haut est ouvert, ou si un risque accepté a expiré. Les décisions humaines sont versionnées dans `security/exceptions.json`, avec une échéance pour chaque risque accepté.
- **Clé maître** : rotation sans perte ([deploy/README.md §10](../deploy/README.md#10-opérations-courantes)).
- **Arrêt d'urgence** : `jules stop --all` coupe toutes les exécutions et révoque leurs jetons ; `jules stop --lift` le lève.
- **Journal d'audit** : `jules audit verify` vérifie la chaîne de hachage.
- **Données personnelles** : durées de conservation appliquées chaque heure (`jules purge`), [ARCHITECTURE.md §18](../ARCHITECTURE.md#18-données-personnelles-et-rétention).

## 6. Exploitation courante

| Besoin | Commande (dans `deploy/`, préfixe `docker compose run --rm worker node dist/cli.js`) |
|---|---|
| Métriques des tâches | `report --days 30` |
| Webhooks manqués | `reconcile --hours 72` |
| Changement de prompt | `eval run …` puis `eval compare` (refuse une régression) |
| État des secrets | `secrets verify` |
| État du schéma | `migrate` (affiche les migrations appliquées) |

Les journaux sont en JSON (`docker compose logs worker`), sans valeur secrète. Les traces OpenTelemetry s'activent par `OTEL_EXPORTER_OTLP_ENDPOINT`.

## 7. Mode local (desktop)

L'app desktop peut faire tourner Jules sur le poste d'une personne, sans serveur : rien à installer côté serveur. Le diagnostic (moteur, isolation, secrets du trousseau, dossiers) est dans [deploy/README.md §11](../deploy/README.md#11-mode-local-app-desktop).
