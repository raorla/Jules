# Jules — Roadmap

> Statut : brouillon v0.3 — 27/10/2026
> Documents liés : [ARCHITECTURE.md](ARCHITECTURE.md), [WORKFLOW.md](WORKFLOW.md), [DESIGN.md](DESIGN.md)

## Vision

Jules 1.0 est une application complète :
- **trois agents** : développeur, DevOps et Sécurité ;
- **trois interfaces** : GitHub, le web, et le desktop pour Linux, Windows et macOS.

On la construit en trois étapes. Chaque étape livre quelque chose d'utilisable avant la suivante.

| Étape | Jalons | Résultat |
|---|---|---|
| 1. Noyau (MVP) | M0 à M5 | l'agent développeur, piloté depuis GitHub, sur tes repos |
| 2. Produit complet (1.0) | M6 à M11 | l'interface web, les agents DevOps et Sécurité, et l'app desktop en mode connecté et en mode local |
| 3. Extensions | après la 1.0 | environnements de preview, GitLab, autres sources de tâches, etc. |

```mermaid
flowchart LR
  M0["M0 Fondations"] --> M1["M1 Sandbox et squelette"]
  M1 --> M2["M2 Machine à états et phases 1-3"]
  M1 --> M3["M3 Gates de vérification"]
  M2 --> M4["M4 Review et boucle humaine"]
  M3 --> M4
  M4 --> M5["M5 Mesures, evals, apprentissage"]
  M5 --> M6["M6 API et interface web"]
  M6 --> M7["M7 Agent DevOps"]
  M7 --> M8["M8 Agent Sécurité"]
  M6 --> M9["M9 Desktop connecté"]
  M9 --> M10["M10 Desktop local"]
  M8 --> M11["M11 Durcissement et 1.0"]
  M10 --> M11
```

Deux paires de jalons peuvent avancer en parallèle :
- M2 et M3, car les gates ne dépendent que du sandbox ;
- la branche desktop (M9, M10) et la branche agents (M7, M8).

**Règle** : un jalon ne commence que lorsque les jalons dont il dépend ont rempli leur Definition of Done.

La taille relative de chaque jalon (S, M, L) indique son effort estimé par rapport aux autres.

## Avant de commencer M0

Ces décisions et préparations ne demandent pas de code, mais M0 en a besoin.

| Élément | Pourquoi maintenant |
|---|---|
| Nom et licence : garder « Jules » (Google a un agent du même nom) ? propriétaire ou open source ? | le nom fixe le scope des packages dès M0, puis les identifiants de l'app desktop et le domaine |
| Hébergement du serveur : machine dédiée ou VPS Linux | M0 déploie déjà le gateway ; gVisor demande Linux |
| Compte Anthropic dédié à Jules, avec une limite de dépense dans la console | second filet derrière le budget du broker, dès M1 |
| Organisation GitHub et repo bac à sable | M0 et M1 s'y testent |
| 2 ou 3 repos pilotes, et 15 à 30 tâches historiques déjà mergées | jeu d'evals de M5 ; mieux vaut le constituer pendant le développement |
| Plus tard, avant M9 : comptes de signature Apple Developer et certificat Windows | délais de validation |

---

## Étape 1 — Noyau (MVP)

### Objectif

Sur un repo de test, puis sur 2 ou 3 de tes vrais repos : une issue `@jules` devient une PR prête pour la review humaine. Elle passe par la spec, la conception, le TDD, les gates déterministes et une review IA indépendante. Aucun secret n'entre jamais dans le sandbox.

### Critères de succès

- 20 tâches réelles traitées sur au moins 2 repos.
- Taux d'acceptation d'au moins 60 %.
- Aucun incident de sécurité.
- 100 % des PR avec une matrice de traçabilité complète (critère → tests).
- Suite de tests de sécurité verte (jalons M1 et M3).
- Coût moyen par PR mergée connu et suivi.

### M0 — Fondations (S)

> Statut (27/10/2026) : code livré et couvert par les tests automatisés de la DoD. Restent la création de la GitHub App, le premier déploiement et l'essai sur le repo bac à sable ([deploy/README.md](deploy/README.md)).

**Livrables**
- Monorepo pnpm + Turborepo, TypeScript strict, Vitest, et la CI du repo Jules (lint, types, tests).
- `CONTRIBUTING.md` : les règles du repo Jules lui-même.
  - Conventional Commits, un ADR par décision structurante, branche principale protégée, review obligatoire.
  - Couverture de 100 % sur `policy`, `workflow` et `risk`.
  - Dépendances épinglées et mises à jour par Renovate, scan osv-scanner.
  - SBOM et signature des images de sandbox.
  - Versions semver et changelog.
- `packages/db` : schéma et migrations ([ARCHITECTURE.md §14](ARCHITECTURE.md#14-données-postgresql)), avec un `org_id` sur chaque table. On ne crée que les tables du noyau ; les autres arrivent avec leur jalon.
- `packages/audit` : journal chaîné et vérification de la chaîne, avec des identifiants internes seulement ([ARCHITECTURE.md §18](ARCHITECTURE.md#18-données-personnelles-et-rétention)).
- `packages/secrets` : chiffrement enveloppe, clé maître hors de la base, procédure de copie de secours.
- La GitHub App, créée avec les permissions exactes (sans `workflows`) et installée sur un repo bac à sable.
- `apps/gateway` : vérification HMAC, déduplication, stockage des événements.
- La réconciliation des webhooks manqués ([ARCHITECTURE.md §17](ARCHITECTURE.md#17-fiabilité-et-exploitation)).
- `deploy/` :
  - docker compose (gateway, worker, postgres), exposé via Cloudflare Tunnel ou Caddy ;
  - sauvegarde quotidienne chiffrée hors de l'hôte.

**Definition of Done**
- Un commentaire `@jules` sur le repo bac à sable crée une tâche, et Jules répond par un commentaire de statut.
- Un webhook dont la signature est invalide, ou qui est rejoué, est rejeté (test automatisé).
- Un `@jules` envoyé pendant que le gateway est arrêté est rattrapé par la réconciliation au redémarrage (test).
- La modification d'une ligne de l'audit log est détectée (test automatisé).
- Une restauration depuis une sauvegarde redonne une base utilisable, secrets compris (test).

### M1 — Sandbox, broker et squelette de bout en bout (L)

> Statut (27/10/2026) : code livré. La DoD est couverte par des tests automatisés : le vrai binaire Claude Code tourne dans le sandbox face à un faux fournisseur de modèle. Les tests tournent avec `runc` sur la machine de développement. Restent l'essai avec gVisor sur le serveur et le refus d'un push de workflow par GitHub, sur le vrai GitHub (côté Jules, ce push est déjà refusé par la policy).

**Livrables**
- `packages/sandbox` : conteneurs gVisor durcis ([ARCHITECTURE.md §8](ARCHITECTURE.md#8-sandbox)), un réseau interne par exécution, destruction garantie.
- L'egress proxy avec son allowlist.
- Le broker :
  - `/capabilities/:name` : jeton d'exécution, validation zod, limites, audit ;
  - `/model/*` : proxy, comptage des tokens, budget, masquage.
- `packages/policy` v1 et les outils toujours refusés.
- `packages/agent-runner` : Agent SDK et serveur MCP `jules`.
- `packages/forge`, implémentation GitHub : clone et push avec garde-fous, PR brouillon, export des commits par `git bundle`.
- La table `outbox` : tous les effets (commentaires, push, PR) passent par elle, avec une clé d'idempotence.
- L'arrêt d'urgence en ligne de commande (`jules stop --all`).
- La résilience face au fournisseur de modèle : nouvelles tentatives, état `waiting_provider`, modèle de secours.
- Une seule phase, volontairement naïve : issue → développeur → push → PR brouillon.

**Definition of Done**
- Une issue simple sur le repo bac à sable donne une PR brouillon correcte.
- Les tests de sécurité automatisés sont tous verts :
  - aucune variable d'environnement ni aucun fichier du conteneur ne contient de jeton GitHub ou de clé API ;
  - depuis le sandbox, `curl https://example.com` échoue alors que `npm install` réussit ;
  - le sandbox ne joint ni Postgres, ni le gateway, ni l'hôte ;
  - un push vers `main` ou un force-push est refusé et journalisé ;
  - un push qui modifie `.github/workflows/` est refusé par GitHub ;
  - un `.git/config` piégé dans le workspace n'exécute rien sur l'hôte ;
  - les outils pièges sont refusés et journalisés ;
  - quand le budget est atteint, l'exécution est coupée.
- Les tests de fiabilité sont verts :
  - si le worker est tué au milieu d'une tâche puis redémarré, il ne produit ni commentaire en double, ni deuxième PR, ni effet perdu ;
  - `jules stop --all` arrête toutes les exécutions en moins de 10 s et révoque leurs jetons ;
  - une panne simulée de l'API modèle met la tâche en `waiting_provider`, puis elle reprend seule.

### M2 — Machine à états, phases 1 à 3, gates humaines (M)

> Statut (27/10/2026) : code livré. Les quatre critères de la DoD sont des tests automatisés qui passent avec le vrai sandbox. Après la build, la tâche s'arrête en `verifying`, avec la PR ouverte en brouillon ; les gates de M3 prennent la suite.

**Livrables**
- `packages/workflow` : états, transitions, gardes et transitions optimistes, avec des tests exhaustifs des transitions.
- Les rôles triager, specifier et architect, avec les schémas d'artefacts (`packages/artifacts`).
- Un commentaire de statut unique, édité à chaque transition.
- `packages/commands` et les commandes `/jules approve`, `revise`, `retry`, `budget`, `pause`, `resume` et `cancel`, avec le contrôle des permissions.
- `packages/risk` v1 (risque estimé), la voie rapide et les niveaux d'autonomie L0, L1 et L2.
- La langue des agents (`language` dans `.jules/config.yml`), en français par défaut.
- `/jules stop-all` depuis GitHub, réservé aux admins.

**Definition of Done**
- Une issue vague donne des questions, et aucun code.
- Une feature de risque `medium` :
  - publie sa spec et attend `/jules approve` ;
  - ignore la même commande venant d'une personne sans droit d'écriture.
- Une correction de coquille (`low`) suit la voie rapide jusqu'à la PR, sans attente.
- En L0, la tâche s'arrête après la conception.

### M3 — Gates de vérification (L)

> Statut (27/10/2026) : code livré. Les 8 PR piégées de la DoD sont bloquées par des tests automatisés, avec le vrai conteneur de vérification. Une PR propre passe ; la CI du projet est attendue, puis prise en compte ; un risque réel plus élevé redemande H2. G4.2 utilise un scanner intégré et G5.11 l'API OSV, plutôt que les binaires gitleaks et osv-scanner. G5.10 (Semgrep) et G5.12 (licences) restent à brancher : elles apparaissent en `skip` dans le rapport.

**Livrables**
- `packages/gates` et le conteneur de vérification, avec la config lue sur la branche par défaut.
- Les gates G4.x avant push et G5.1 à G5.14, publiées dans le check run `Jules / gates`.
- La boucle développement ↔ vérification, bornée.
- Le risque réel recalculé sur le diff, avec la gate H2 exigée si le risque dépasse ce qui a été approuvé.

**Definition of Done** : un jeu de PR piégées est entièrement bloqué. Chaque cas est un test automatisé :
- un secret dans le code ;
- une dépendance vulnérable ;
- un test supprimé ;
- un `.skip` ajouté ;
- un seuil de couverture abaissé dans la config de la branche (il doit être ignoré, car la config est lue sur `main`) ;
- un diff non couvert par les tests ;
- un bug corrigé sans test qui échoue sur la base ;
- un workflow de CI modifié.

### M4 — Review, traçabilité et boucle humaine (M)

**Livrables**
- Le rôle reviewer (autre modèle, contexte vierge) :
  - review de type `COMMENT` avec commentaires en ligne ;
  - check run `Jules / review` ;
  - rounds bornés.
- La description de PR avec la matrice de traçabilité.
- En L2 : passage de la PR en « ready » et demande des reviewers CODEOWNERS.
- La review humaine « Request changes » et `/jules fix`, qui relancent une itération sur la même branche.
- Les rulesets recommandés, documentés et appliqués sur les repos pilotes.
- `@jules setup` : onboarding d'un repo, qui produit une PR avec la config proposée, les CODEOWNERS et la liste des rulesets manquants.

**Definition of Done**
- Les repos pilotes ont été mis en place avec `@jules setup`.
- Le pipeline complet tourne sur 10 issues réelles d'un repo pilote.
- Une PR dont un critère n'est pas implémenté est renvoyée en développement par le reviewer.

### M5 — Mesures, evals et apprentissage (M)

**Livrables**
- Les traces OpenTelemetry et les métriques ([WORKFLOW.md §10](WORKFLOW.md#10-métriques-et-promotion-dautonomie)).
- Un rapport hebdomadaire sous forme de commande `jules report` ; il passera dans l'interface web en M6.
- La suite d'evals (15 à 30 tâches historiques), avec son runner, son scoring et des prompts versionnés.
- Le rôle learner, les commandes `/jules lesson approve` et `reject`, et l'injection des leçons approuvées dans le contexte.
- La purge automatique selon les durées de conservation ([ARCHITECTURE.md §18](ARCHITECTURE.md#18-données-personnelles-et-rétention)).

**Definition of Done**
- Un changement de prompt est évalué avant déploiement, et refusé s'il fait régresser le score.
- Le rapport donne le taux d'acceptation, le coût par PR mergée et le taux de gates au premier essai.

### Pilote du noyau

Après M5, le noyau est déployé en L1 sur 2 ou 3 repos de `MTONGASWARM`. Chaque repo passe en L2 séparément, selon la règle de promotion de [WORKFLOW.md §10](WORKFLOW.md#10-métriques-et-promotion-dautonomie). Le pilote continue pendant toute l'étape 2 : c'est lui qui fournit les données réelles des métriques et des evals.

---

## Étape 2 — Produit complet (1.0)

### Critères de succès de la 1.0

- Les trois agents tournent sur tes repos et tes serveurs depuis au moins un mois, sans incident de sécurité.
- Chaque fonction est utilisable depuis le web et le desktop, et les fonctions du noyau le restent depuis GitHub.
- L'app desktop s'installe et se met à jour sur Linux, Windows et macOS, en mode connecté et en mode local.
- Tous les tests de sécurité sont verts, en mode serveur et en mode local.
- Les métriques DORA et Sécurité sont mesurées ([WORKFLOW.md §12.3 et §13.3](WORKFLOW.md#12-workflow-de-lagent-devops)).

### M6 — API et interface web (L)

**Livrables**
- `apps/api` :
  - connexion GitHub OAuth, sessions, rôles Jules ;
  - passkeys (WebAuthn) exigées pour les actions sensibles ;
  - REST versionné (`/v1`) et temps réel (SSE) ;
  - secrets en écriture seule (sealed box).
- `packages/commands` branché sur l'api : les boutons et les commandes GitHub passent par le même code.
- `packages/ui` et `apps/web` ([ARCHITECTURE.md §4.6](ARCHITECTURE.md#46-interface-web-appsweb)) :
  - tableau de bord ;
  - page tâche (chronologie, artefacts, diff, gates, review, coût, transcriptions masquées) ;
  - file d'approbations ;
  - réglages ;
  - audit, métriques, résultats des evals.
- Création de tâche depuis le web, qui crée l'issue GitHub.
- Le système de design de [DESIGN.md](DESIGN.md) : tokens du skill `warm-dark-ui`, thèmes sombre et clair, composants propres à Jules.
- L'interface en français et en anglais.
- Le bouton d'arrêt d'urgence.

**Definition of Done**
- Une tâche complète se suit et se pilote entièrement depuis le web, et les mêmes actions restent possibles depuis GitHub.
- Une approbation donnée sur le web puis sur GitHub : la seconde est refusée proprement.
- Un `member` sans droit d'écriture sur le repo GitHub ne peut pas approuver (test).
- Un artefact qui contient du HTML ou du JavaScript ne l'exécute pas (test XSS).
- Les requêtes forgées depuis un autre site sont refusées (test CSRF).
- L'api ne peut pas relire un secret qu'elle a écrit (test).
- Une action sensible tentée avec une session valide mais sans passkey est refusée (test).
- Parcours principaux couverts par des tests Playwright.
- La checklist de [DESIGN.md §12](DESIGN.md#12-vérification) passe : captures à 1280 et 390 px, dans les deux thèmes, et contrastes vérifiés.

### M7 — Agent DevOps (L)

**Livrables**
- `packages/ssh` : connexions durcies, clé d'hôte épinglée, ssh-agent temporaire, `sudo -n`, délais.
- `packages/devops` :
  - classification des commandes par parseur shell ;
  - plans de changement exécutés par le worker ;
  - playbooks (paramètres typés, vérification, retour arrière) ;
  - pipeline de déploiement staging → production ([WORKFLOW.md §12](WORKFLOW.md#12-workflow-de-lagent-devops)).
- Les outils `server_*`, les niveaux D0 à D3, les approbations dans le web avec notifications.
- Le verrou par serveur et le journal des étapes de chaque plan (`interrupted` en cas d'arrêt du worker).
- L'option « quatre yeux » pour la production.
- Les pages serveurs, playbooks, historique des commandes et déploiements. L'enregistrement d'un serveur inclut la validation de sa clé d'hôte.
- Depuis GitHub ([ARCHITECTURE.md §12](ARCHITECTURE.md#12-intégration-github)) :
  - `@jules devops <demande>` et l'approbation des plans hors production ;
  - le statut des déploiements sur les commits et dans les PR (permission `deployments`).
- Les métriques DORA.

**Definition of Done**
- Un jeu de commandes piégées est correctement classé (test) :
  - `rm -rf /`, une commande obfusquée en base64, `curl … | sh`, une lecture de `.env`, `dd` vers un disque → `dangerous` ;
  - une commande inconnue → au moins `change`.
- Une action absente du plan approuvé est refusée et demande un nouveau plan.
- Si le worker est tué au milieu d'un plan, le plan passe en `interrupted` et aucune étape n'est relancée seule (test).
- Deux plans lancés en même temps sur le même serveur s'exécutent l'un après l'autre (test).
- L'approbation de la production depuis GitHub est refusée tant qu'un admin ne l'a pas activée (test).
- Un changement de clé d'hôte bloque le serveur.
- Un déploiement complet staging → production réussit sur un repo pilote, avec un retour arrière déclenché volontairement en staging.
- Aucune clé SSH n'apparaît dans le sandbox, les logs ou l'audit (test).

### M8 — Agent Sécurité (M)

**Livrables**
- `packages/security` :
  - audits du code, des images, des serveurs et de la plateforme ;
  - résultats des scanners enregistrés directement en findings.
- Le cycle de vie des findings ([WORKFLOW.md §13](WORKFLOW.md#13-workflow-de-lagent-sécurité)) : échéances par sévérité, risque accepté avec échéance, faux positifs confirmés par un humain.
- Les audits planifiés (scheduler).
- La remédiation par le pipeline développeur ou par une demande DevOps.
- Le blocage des déploiements par les findings critiques et hauts.
- Le security reviewer en phase 6, pour les PR à risque `high`.
- La page findings et le tableau de bord sécurité.
- Sur GitHub, pour les repos privés : envoi des failles du code en SARIF (permission `security_events`) et issues `security` pour les failles critiques et hautes.

**Definition of Done**
- Sur un repo de test qui contient une faille connue, le cycle complet se déroule : un finding est créé, puis une tâche de remédiation, puis une PR, et le finding passe en `resolved` après un nouvel audit.
- Un finding `high` ouvert bloque le playbook `deploy` de sa cible.
- L'agent ne reçoit jamais une valeur secrète, même en auditant un serveur rempli de fichiers `.env` (test).
- Sur un repo public, aucune faille n'est publiée sur GitHub (test).

### M9 — App desktop, mode connecté (M)

**Livrables**
- `apps/desktop` (Tauri 2), qui embarque `packages/ui`.
- La connexion à un serveur Jules : OAuth avec PKCE dans le navigateur du système, jeton rangé dans le trousseau.
- Les fonctions propres au desktop :
  - notifications natives ;
  - icône dans la barre système avec les approbations en attente ;
  - ouverture d'un diff ou d'un repo local dans l'éditeur.
- Les builds signés : Linux (AppImage, deb, rpm), Windows (MSI), macOS (dmg universel, notarisé).
- Les mises à jour automatiques signées, et une CI de build sur les trois OS.
- Avant ce jalon : les comptes de signature (Apple Developer, certificat Windows).

**Definition of Done**
- L'installation et la connexion sont testées sur Ubuntu, Windows 11 et macOS (Apple Silicon et Intel).
- Une approbation DevOps peut être donnée depuis une notification.
- Une mise à jour publiée est installée automatiquement, et une mise à jour non signée est refusée.
- Un desktop trop ancien pour le serveur demande une mise à jour au lieu de se connecter (test).

### M10 — App desktop, mode local (L)

**Livrables**
- Le lancement et la supervision de la pile locale (worker, PostgreSQL, egress proxy) par Docker ou Podman, avec détection et aide à l'installation si aucun des deux n'est présent.
- La forge locale (`packages/forge`) : branches dans le repo local, écran de review dans l'app, merge par un bouton (action humaine).
- Les secrets rangés dans le trousseau du système et transmis au worker au démarrage.
- L'affichage du niveau d'isolation : gVisor sous Linux, VM de Docker Desktop sous macOS et Windows.
- Le passage d'un mode à l'autre sans réinstaller.

**Definition of Done**
- Le pipeline développeur complet tourne sur un dossier local, sans GitHub, sur les trois OS.
- Les tests de sécurité de M1 passent aussi en mode local, adaptés à chaque OS.
- Aucun secret n'est écrit en clair sur le disque (test).

### M11 — Durcissement et version 1.0 (M)

**Livrables**
- Sauvegarde continue de PostgreSQL (restauration à un instant donné), en plus de la sauvegarde quotidienne de M0 ; exercice de reprise complet sur une machine neuve.
- Montées de version avec migrations testées.
- Installation du serveur en une commande (script et docker compose), avec un guide.
- Documentation utilisateur et administrateur.
- Audit de sécurité de Jules lui-même : par l'agent Sécurité, plus une revue externe ou un test d'intrusion.
- Tests de charge : plusieurs tâches et plusieurs serveurs en même temps.

**Definition of Done**
- Une restauration depuis une sauvegarde est testée.
- La montée de version depuis la version précédente se fait sans perte de données.
- Aucun finding critique ou haut n'est ouvert sur Jules.
- Les critères de succès de la 1.0 sont remplis.

---

## Étape 3 — Extensions (après la 1.0)

- Phase 7 du workflow : environnements de preview, tests Playwright, captures jointes aux PR.
- Reviewers spécialisés supplémentaires (migrations, performance).
- Support de GitLab.
- Intake depuis Linear, Trello ou Jira.
- Notifications externes (e-mail, Telegram, Slack).
- Images de sandbox construites depuis `devcontainer.json`.
- Recherche dans l'historique des tâches (pgvector).
- Commits signés.
- Plusieurs tâches en parallèle sur un même repo.
- Merge automatique des PR à faible risque, **seulement** si les métriques le justifient.

## Risques du projet

| Risque | Impact | Parade |
|---|---|---|
| Périmètre très large | la 1.0 n'arrive jamais | trois étapes livrables ; le noyau sert dès M5 ; une Definition of Done testable par jalon ; pas de jalon commencé avant ceux dont il dépend |
| Les modèles coûtent plus cher que prévu | budget | budget par tâche ; coût par PR mergée suivi dès M1 ; réglages d'effort testés avec les evals |
| L'Agent SDK évolue | l'agent-runner casse | version épinglée ; agent-runner isolé derrière une interface ; tests de contrat |
| Faux positifs des gates et des scanners | tâches bloquées, findings ignorés | seuils réglables par repo ; mode avertissement au démarrage ; faux positifs confirmés par un humain |
| Repos sans tests | gates de test inapplicables | G5.6 et G5.7 en avertissement ; tâche « mettre en place les tests » proposée en L0 |
| Fatigue d'approbation (DevOps) | approbations données sans lire | playbooks ; une approbation par plan ; commande exacte affichée ; nombre d'approbations suivi |
| Une erreur DevOps en production | panne | production toujours approuvée ; vérification et retour arrière obligatoires dans chaque plan ; staging avant production |
| Signature des apps desktop | coût annuel, délais de validation | comptes Apple Developer et certificat Windows ouverts avant M9 |
| Docker sur le poste des utilisateurs | installation pénible, surtout sous Windows | détection et aide à l'installation ; Podman en alternative |
| Isolation plus faible en mode local sous macOS et Windows | risque d'évasion plus élevé | niveau d'isolation affiché ; mode serveur recommandé pour les repos sensibles |
| Limites de l'API GitHub | ralentissements | jetons d'installation, ETags, appels regroupés |
| Évasion du sandbox | compromission de l'hôte | gVisor ; hôte dédié sans autres données ; mises à jour régulières |
| Trop de cérémonie | Jules trop lent pour les petites tâches | voie rapide ; niveaux d'autonomie |
