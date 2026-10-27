# Jules — Design de l'interface

> Statut : brouillon v0.1 — 27/10/2026
> Documents liés : [ARCHITECTURE.md](ARCHITECTURE.md) (§4.6 interface web, §4.7 app desktop), [ROADMAP.md](ROADMAP.md) (M6, M9)

L'interface web et l'app desktop partagent le même système : ton style « warm dark », celui de cache.mg, SnipAlert, DeltaLaunch et PixStock. La source de vérité est le skill `warm-dark-ui` (`~/.claude/skills/warm-dark-ui`). Ce document dit comment Jules l'applique ; il ne recopie pas le skill.

## 1. Mise en place dans `packages/ui`

| Élément | Source dans le skill | Dans Jules |
|---|---|---|
| Tokens (rampes sombre et claire, typo, rayons, mouvement, teintes sémantiques, séries de graphiques) | `references/tokens.css` | copié tel quel dans `packages/ui/src/styles/tokens.css`, avec le bloc `@theme inline` de Tailwind v4 activé |
| Recettes de composants | `references/components.md` | mêmes noms de classes, enveloppés dans des composants React ; on étend, on ne réinvente pas |
| Graphiques | `references/charts.md` | thème appliqué aux graphiques des métriques |
| Page de référence | `assets/starter.html` | modèle de l'app shell pour le premier écran de M6 |

Les composants demandent un **rôle** (`var(--surface-2)`, `var(--ink-3)`), jamais une valeur hexadécimale.

## 2. Règles reprises du skill

- Fond chaud, jamais neutre : `--ground` `#1c1a17` en sombre, `#f1efec` en clair.
- Le texte secondaire utilise la rampe `--ink` → `--ink-2` → `--ink-3`, jamais l'opacité.
- Chaque contrôle est une pilule. Une seule action principale (pilule crème) par zone.
- Cartes de 24 px de rayon, sans bordure, séparées de 8 px. Seuls les éléments flottants (barre latérale, dialogues) ont un filet de 12 %.
- Un seul nombre dominant par écran.
- La couleur a toujours un sens : `--ok`, `--crit`, `--warn`, `--info`, `--violet`, sous forme de texte sur une teinte à 14 % ou de point de 7 px.
- Police du système, icônes en trait (lucide, trait 2, 14 à 17 px), mouvements courts (150 à 200 ms).

## 3. Thèmes

- **Sombre** par défaut, **clair** avec la classe `.light` sur `<html>`.
- Au premier lancement, l'interface suit la préférence du système (`prefers-color-scheme`). L'utilisateur peut ensuite choisir dans ses réglages.
- L'app desktop suit le thème du système.

## 4. Sens des couleurs dans Jules

La même couleur veut toujours dire la même chose, sur tous les écrans.

| Ton | Signification dans Jules |
|---|---|
| `--ok` | gate `pass`, PR mergée, déploiement réussi, finding résolu, serveur sain |
| `--crit` | gate `fail`, tâche `failed` ou `blocked`, finding `critical` ou `high`, déploiement échoué, commande `dangerous` refusée |
| `--warn` | gate `warn`, **action humaine attendue** (`awaiting_*`, approbation en attente), finding `medium`, échéance proche, budget à plus de 80 % |
| `--info` | travail en cours : `triaging`, `building`, `verifying`, `reviewing`, déploiement en cours |
| `--violet` | contenu écrit par un agent (badge « IA » sur un artefact, une review, un commentaire) |
| `--ink-3` (neutre) | `skip`, `cancelled`, risque `low`, finding `low` |

Badges qui restent toujours visibles :

| Badge | Rendu |
|---|---|
| Environnement | `production` en puce `crit`, `staging` en puce `warn`, `development` en puce neutre. Il apparaît sur chaque commande, plan, approbation et déploiement. |
| Risque | `high` en `crit`, `medium` en `warn`, `low` en neutre |
| Classe de commande | `dangerous` en `crit`, `change` en `warn`, `read` en neutre |
| Autonomie | puce neutre : `L0` à `L2`, `D0` à `D3`, `S0` ou `S1` |

Une couleur n'est jamais seule : chaque puce porte aussi un texte.

Deux ajustements de contraste propres à Jules, mesurés par axe-core (§12), sans toucher aux tokens du skill :
- **texte des puces** : le ton est mêlé à 20 % d'encre (`color-mix(in srgb, var(--crit) 80%, var(--ink))`). Le rouge pur ne tient que 4,05:1 sur sa teinte posée sur une ligne en retrait ; le mélange éclaircit en sombre, fonce en clair, et tient 4,5:1 dans les deux thèmes ;
- **texte secondaire sur `--recess`** (méta des lignes, identifiants de gates, contrôles segmentés) : le rôle `--ink-recess`, égal à `--ink-3` en sombre et à `--ink-2` en clair, où `--ink-3` ne tient que 4,28:1 sur `--recess`.

## 5. App shell

C'est l'app shell du skill (§4 de `components.md`) : une barre latérale flottante et givrée, et une colonne de cartes à 8 px d'écart.

**Barre latérale :**

| Section | Entrées |
|---|---|
| Travail | Tableau de bord, Tâches, Approbations (avec un compteur `--warn`) |
| Exploitation | Serveurs, Déploiements |
| Sécurité | Findings, Audits |
| Pilotage | Métriques, Journal d'audit, Evals |
| — | Réglages |

**Barre du haut :**
- recherche en pilule, qui ouvre aussi la palette de commandes (`Ctrl/⌘ K`) ;
- sélecteur d'organisation (caché tant qu'il n'y en a qu'une) ;
- bouton **Arrêt d'urgence** pour les admins : pilule fantôme en `--crit`, toujours visible ;
- avatar.

## 6. Écrans et nombre dominant

| Écran | Nombre ou élément dominant | Contenu |
|---|---|---|
| Tableau de bord | **approbations en attente** | ligne de KPI (approbations en attente, tâches en cours, coût du mois, findings critiques et hauts ouverts), tâches en cours, derniers déploiements |
| Tâche | **l'état courant et l'action attendue** | frise des phases, artefact de la phase, rapport de gates, diff, review, coût, transcriptions masquées, boutons de commande |
| Approbations | **nombre en attente** | une carte par demande ; la production utilise la carte d'alerte avec anneau lumineux du skill (§14) |
| Serveurs | **serveurs en alerte** | une ligne par serveur : point d'état, environnement, niveau D, dernier changement |
| Déploiements | **état du dernier déploiement en production** | historique, PR incluses, vérifications, retours arrière |
| Findings | **critiques et hauts ouverts** | liste par sévérité, échéance, remédiation liée |
| Métriques | **taux d'acceptation** | graphiques selon `charts.md` : métriques agents, DORA, Sécurité |
| Réglages | — | champs en creux (`--recess`), dialogues avec interrupteurs |

**États vides** : on reprend le titre deux tons du skill, avec une ou deux phrases qui disent quoi faire. Par exemple : « Aucune tâche pour l'instant. Mentionne `@jules` dans une issue, ou crée une tâche ici. »

## 7. Composants propres à Jules

Ils sont construits sur les recettes du skill.

| Composant | Base | Comportement |
|---|---|---|
| `PhaseTimeline` | puces et points | 9 phases, à l'horizontale sur ordinateur et à la verticale sur mobile ; la phase en cours a un anneau `--info` qui pulse, une phase qui attend un humain est en `--warn` |
| `ArtifactCard` | carte + titre en sourcil | affiche une spec, une conception ou une review ; tableau des critères d'acceptation ; Markdown assaini ; badge « IA » |
| `GateReport` | lignes imbriquées | une ligne par gate : puce d'état, durée en chiffres tabulaires, détail dépliable |
| `DiffViewer` | creux + police mono | contrôle segmenté « unifié / côte à côte » ; ajouts sur `--ok-bg`, suppressions sur `--crit-bg`, numéros de ligne en `--ink-3` |
| `ApprovalCard` | carte d'alerte (§14 du skill) | commande ou plan exact, environnement, raison, impact, vérification, retour arrière ; « Refuser » en pilule fantôme, « Approuver » en pilule crème ; en production, l'approbation ouvre le dialogue de passkey |
| `CommandLog` | creux + police mono | sortie des commandes ; une valeur masquée s'affiche comme une puce « masqué » |
| `CostMeter` | barre de progression du skill | budget consommé : `--ok`, puis `--warn` au-delà de 80 %, puis `--crit` à 100 % |
| `EnvBadge`, `RiskChip`, `SeverityChip`, `CommandClassChip`, `AutonomyChip` | puces | voir §4 |
| `KillSwitch` | pilule fantôme `--crit` + dialogue | confirmation, puis passkey |
| `CommandPalette` | recherche en pilule + dialogue | navigation et commandes au clavier |

## 8. Accessibilité

- Texte courant à un contraste d'au moins 4,5:1 (règle du skill), vérifié dans les deux thèmes.
- Jamais d'information portée par la seule couleur.
- Focus toujours visible (contour crème du skill).
- Tout se fait au clavier. Pour la production, aucune approbation ne se donne d'une seule touche : il faut toujours un dialogue et la passkey.
- `prefers-reduced-motion` désactive les anneaux qui pulsent.
- Les mises à jour en temps réel sont annoncées par une région ARIA `polite`, et `assertive` pour les findings critiques.

## 9. Responsive

- L'interface tient à partir de 380 px de large (checklist du skill) :
  - la barre latérale passe au-dessus du contenu ;
  - la ligne de KPI passe à 2 colonnes ;
  - il n'y a jamais de défilement horizontal, sauf dans le diff.
- La file d'approbations est pensée pour un téléphone : on doit pouvoir approuver ou refuser depuis le navigateur mobile.

## 10. Langues

- Français (par défaut) et anglais dès M6.
- Les textes sont dans `packages/ui/src/i18n/fr.json` et `en.json`.
- Les dates, nombres et montants passent par `Intl`, selon la langue choisie.
- La langue de l'interface est indépendante de celle des agents (`language` dans `.jules/config.yml`).

## 11. App desktop

- Barre de titre native sur les trois OS.
- Menu de la barre système : approbations en attente, état des exécutions, accès à l'arrêt d'urgence.
- Notifications natives, avec un texte court qui nomme l'environnement : « Production · app-prod : approbation demandée ».

## 12. Vérification

À chaque PR qui touche `packages/ui` :
- la checklist du skill (fond chaud, aucune opacité sur le texte, pilules, cartes sans bordure, icônes dimensionnées, chiffres tabulaires, tenue à 380 px) ;
- des captures Playwright à 1280 px et 390 px, en thème sombre et clair, comparées aux captures de référence (`apps/web/e2e/__screenshots__`, régénérées volontairement avec `--update-snapshots` quand un écran change) ;
- un contrôle automatique des contrastes (axe-core) ;
- les vérifications propres à Jules :
  - l'environnement est visible sur chaque action serveur ;
  - aucune approbation de production sans passkey ;
  - chaque puce colorée porte un texte.
