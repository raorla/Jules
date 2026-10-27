# Evals de Jules

Un changement de prompt, de modèle, d'effort ou de règle passe la suite d'evals avant d'être déployé ([WORKFLOW.md §11](../WORKFLOW.md#11-le-sdlc-de-jules-lui-même)). S'il fait régresser le score, il est refusé.

## Ce que contient la suite

- `fixtures/<nom>/` : l'état d'un repo avant la tâche, copié comme premier commit de `main`.
- `tasks/<id>/task.json` : la tâche (`id`, `fixture`, `type`, `issue.title`, `issue.body`).

Les cinq tâches livrées servent d'exemple et de test : trois fonctionnalités sur `node-basic` (`mul`, `sum-strings`, `readme-sum`) et deux bugs sur `node-bugs` (`average-empty`, `round-half`), qui mesurent la boucle de diagnostic du développeur (reproduire par un test qui échoue, puis corriger la cause). La vraie suite, c'est 15 à 30 tâches tirées de tes repos, déjà mergées : pour chacune, copie l'état du repo avant le merge dans `fixtures/`, et l'issue d'origine dans `tasks/`.

## Score

Chaque tâche est jouée de bout en bout, sandbox compris, avec les gates humaines approuvées automatiquement. Le score est sur 100 :

| Part | Points | Mesure |
|---|---|---|
| Gates | 40 | part des gates non en échec sur la dernière vérification |
| Critères | 30 | part des critères `met` selon la review IA |
| Review | 15 | `approve` 15, `escalate` 7, sinon 0 |
| Coût | 15 | 15 si gratuit, 0 au budget de la tâche |

Une tâche qui n'atteint pas la PR est plafonnée à 10.

## Lancer

Sur une base dédiée aux evals (elle reçoit des tâches de test), avec Docker et les images du sandbox :

```bash
DATABASE_URL=postgres://…/jules_evals pnpm jules eval run --suite evals --prompts prompts --label main --out evals/results/main.json
DATABASE_URL=postgres://…/jules_evals pnpm jules eval run --suite evals --prompts /chemin/prompts-candidats --label candidat --out evals/results/candidat.json
pnpm jules eval compare evals/results/main.json evals/results/candidat.json
```

`compare` sort avec le code 1 si le score total baisse de plus de 2 points (`--tolerance`) : c'est le refus.

Chaque exécution appelle le vrai modèle et coûte de l'argent : la suite complète vaut à peu près le budget d'une tâche, multiplié par le nombre de tâches.
