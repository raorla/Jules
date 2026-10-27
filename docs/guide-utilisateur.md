# Guide d'utilisation de Jules

Ce guide s'adresse aux personnes qui confient du travail à Jules : développeurs, responsables d'un repo, équipe d'exploitation. Pour installer et faire tourner Jules, voir le [guide d'administration](guide-admin.md). Le fonctionnement détaillé est dans [WORKFLOW.md](../WORKFLOW.md).

## 1. Ce que fait Jules

Jules fait travailler trois agents. Aucun ne merge, aucun ne voit un secret, et la production demande toujours l'accord d'un humain.

| Agent | Tu lui confies | Il te rend |
|---|---|---|
| Développeur | une issue | une PR relue par un second modèle, avec ses tests et la preuve que chaque critère d'acceptation est couvert |
| DevOps | une demande sur un serveur (`@jules devops …`) | un diagnostic, puis un plan de changement à approuver, exécuté étape par étape avec vérification et retour arrière |
| Sécurité | rien : il audite seul, chaque jour et après chaque merge | des findings classés par gravité, avec une échéance, et en S1 des tâches de remédiation |

Tu pilotes Jules depuis trois endroits, avec les mêmes commandes et les mêmes droits :
- **GitHub** : mentions et commandes `/jules` dans les issues et les PR ;
- **l'interface web** : tableau de bord, tâches, approbations, serveurs, déploiements, sécurité, réglages ;
- **l'app desktop** (Linux, Windows, macOS) : l'interface web, plus les notifications natives, la barre système et le mode local.

## 2. Confier une tâche au développeur

1. Écris une issue claire : pour un bug, ce que tu observes, ce que tu attends, et comment le reproduire ; pour une fonctionnalité, qui en a besoin, pourquoi, et au moins un critère d'acceptation.
2. Mentionne `@jules` dans l'issue, ou pose le label `jules`. Depuis le web ou le desktop : **Nouvelle tâche**.
3. Jules répond par un commentaire de statut, mis à jour à chaque phase : tri, spec, conception, développement, vérification, review.

Selon le risque et l'autonomie du repo, Jules s'arrête pour te demander ton accord :
- **H1, la spec** : relis les critères d'acceptation (« étant donné, quand, alors »). `/jules approve` pour valider, `/jules revise <ton retour>` pour la refaire ;
- **H2, la conception** : relis l'approche, les fichiers touchés et le plan de tests. Mêmes commandes.

S'il lui manque une information, la tâche passe en attente : réponds simplement dans l'issue.

La PR arrive avec :
- la spec, la conception et la matrice de traçabilité (chaque critère → ses tests → leur résultat) ;
- le rapport des gates (build, lint, types, tests, couverture du diff, secrets, dépendances, chemins protégés) ;
- la review du second modèle, en commentaire, jamais en approbation.

Tu relis la PR comme celle d'un collègue. Pour demander une correction : une review « Request changes » ou `/jules fix <instructions>`. Le merge reste à toi.

Après le merge, Jules peut proposer des **leçons** pour ce repo (« les fonctions de calcul vivent dans `src/math.js` »). Un maintainer les valide (`/jules lesson approve <id>`) ; elles servent alors aux tâches suivantes.

## 3. Commandes

| Commande | Où | Effet | Qui |
|---|---|---|---|
| `@jules <demande>` ou label `jules` | issue | crée la tâche | `write` |
| `/jules approve` | issue | valide la spec ou la conception en attente | `write` (`maintain` si le risque est haut) |
| `/jules revise <retour>` | issue | refait la phase en cours avec ton retour | `write` |
| `/jules fix <instructions>` | PR | nouvelle itération sur la même branche | `write` |
| `/jules retry` | issue ou PR | relance une tâche bloquée ou en échec | `write` |
| `/jules budget +<n>` | issue ou PR | augmente le budget de la tâche (dans la limite globale) | `maintain` |
| `/jules pause`, `/jules resume`, `/jules cancel` | issue ou PR | suspend, reprend ou annule la tâche | `write` |
| `/jules lesson approve <id>` | PR | valide une leçon proposée | `maintain` |
| `@jules setup` | issue | onboarding du repo : config, CODEOWNERS, règles de branche, en PR | `maintain` |
| `@jules devops <demande>` | issue | demande au DevOps | `write` |
| `/jules stop-all` | issue ou PR | arrêt d'urgence de toutes les exécutions | `admin` |

Chaque commande existe aussi en bouton dans le web et le desktop. Certaines actions demandent une **passkey** au moment de l'action, et ne se font donc que depuis le web ou le desktop : approuver la production, modifier un secret, relever une autonomie, accepter un risque, lever l'arrêt d'urgence.

## 4. Autonomie d'un repo

| Niveau | Ce que fait Jules |
|---|---|
| L0, conseiller | spec et plan dans l'issue, aucun code poussé |
| L1, supervisé | tout le cycle ; spec et conception toujours approuvées par un humain ; la PR reste en brouillon |
| L2, autonome sur faible risque | les approbations selon le risque ; la PR passe en « ready » et les CODEOWNERS sont demandés |

Un repo commence en L0. Un admin le fait monter quand les métriques le justifient (`jules report`, [WORKFLOW.md §10](../WORKFLOW.md#10-métriques-et-promotion-dautonomie)) ; relever une autonomie demande une passkey.

## 5. DevOps

1. Ouvre une issue `@jules devops <ce qui ne va pas, ou ce que tu veux changer>`, ou utilise la page **Serveurs**.
2. L'agent diagnostique en lecture seule, puis soumet un **plan de changement** : les commandes exactes, l'impact, la vérification et le retour arrière.
3. Tu l'approuves (passkey pour la production). Le worker l'exécute tel quel, à l'octet près : une commande hors du plan est refusée.

La page **Déploiements** montre le chemin staging → production de chaque merge, et les métriques DORA. Chaque commande, plan et approbation affiche son environnement : `production` en rouge, `staging` en orange.

## 6. Sécurité

La page **Sécurité** liste les findings ouverts : gravité, cible (repo, serveur ou Jules), composant, échéance, analyse de l'agent. Pour chacun, un humain décide :
- **corriger** : en S1, l'agent propose une tâche de remédiation (une PR pour un repo privé, une demande DevOps pour un serveur) ;
- **faux positif** : avec une justification ;
- **risque accepté** : avec une justification, une échéance de moins d'un an et une passkey.

Un finding critique ou haut encore ouvert bloque les déploiements. Pour un repo public, rien n'est publié sur GitHub : la faille reste dans Jules.

## 7. L'app desktop

Au premier lancement, choisis le mode :
- **Avec un serveur Jules** (mode connecté) : l'adresse du serveur, puis la connexion GitHub dans ton navigateur. Les approbations arrivent en notifications natives, avec leur environnement ; un clic ouvre le plan, prêt à approuver.
- **Sur cette machine** (mode local) : Jules tourne chez toi, avec Docker ou Podman, sur tes dossiers git, sans GitHub. Ajoute un dossier dans **Réglages → Dossiers de cette machine**, crée une tâche, et suis-la comme sur un serveur. Les branches de Jules arrivent dans ton dossier ; la page de la tâche montre le diff, les artefacts, les gates, et le bouton **Merger dans la branche de base** (si ton dossier a des modifications non commitées, le merge est refusé : commite ou mets-les de côté, puis recommence).

En mode local, le badge en bas de la barre latérale indique l'**isolation** des agents : gVisor (comme sur un serveur), la VM de Docker Desktop (macOS, Windows) ou un conteneur ordinaire. Pour un repo sensible, préfère un serveur Jules.

Tu changes de mode depuis **Réglages → Mode de l'app**, sans réinstaller.

## 8. En cas de problème

- **La tâche est bloquée** : le statut dit pourquoi (gate en échec, budget atteint, chemin protégé touché). Corrige ou ajoute du budget, puis `/jules retry`.
- **Le fournisseur de modèle est en panne** : la tâche attend (`waiting_provider`) et reprend seule.
- **Quelque chose dérape** : un admin déclenche l'arrêt d'urgence (bouton rouge en haut de l'interface, ou `/jules stop-all`). Toutes les exécutions s'arrêtent en quelques secondes ; la levée demande une passkey.
