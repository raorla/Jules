# Jules

Jules est une plateforme autohébergée d'agents de développement. Elle fait travailler trois agents :

- **Développeur** : on lui confie une issue. Il la fait passer par un cycle complet et livre une pull request prête à être relue par un humain :
  1. spec ;
  2. conception ;
  3. tests écrits d'abord ;
  4. implémentation ;
  5. vérifications automatiques ;
  6. review par un second modèle.
- **DevOps** : il opère les serveurs par SSH. Il diagnostique, propose des plans de changement et déploie de staging à production, avec une approbation humaine.
- **Sécurité** : il audite le code, les dépendances, les images et les serveurs, puis suit chaque faille jusqu'à sa correction.

On pilote Jules depuis GitHub, depuis l'interface web, ou depuis l'app desktop (Linux, Windows, macOS). Aucun agent ne merge, aucun agent n'a accès à un secret, et la production passe toujours par une approbation humaine.

**Statut** : M0 (fondations) dans le repo. Le gateway reçoit les webhooks GitHub, le worker crée la tâche et répond par un commentaire de statut. Le journal d'audit et les secrets sont en place. Le sandbox et les agents arrivent en M1. Pour travailler sur le code : [CONTRIBUTING.md](CONTRIBUTING.md). Pour déployer : [deploy/README.md](deploy/README.md).

| Document | Contenu |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | composants, zones de confiance, sandbox, agents et outils, exécution SSH, interfaces web et desktop, intégration GitHub, modèle de menaces, stack |
| [WORKFLOW.md](WORKFLOW.md) | les cycles des agents : phases, artefacts, gates, commandes, traçabilité, déploiements, findings, métriques |
| [ROADMAP.md](ROADMAP.md) | le chemin jusqu'à la 1.0 : ce qu'il faut avant de commencer, noyau (M0 à M5), produit complet (M6 à M11), extensions, risques |
| [DESIGN.md](DESIGN.md) | l'interface web et desktop dans le système « warm dark » : tokens, sens des couleurs, écrans, composants, accessibilité |

Jules s'inspire de [Boubou](https://boubou.evolueoo.com/docs/architecture). Les différences sont détaillées dans [ARCHITECTURE.md §22](ARCHITECTURE.md#22-différences-avec-boubou).
