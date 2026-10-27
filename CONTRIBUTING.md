# Contribuer à Jules

Les règles du repo Jules lui-même. Le cycle de développement de Jules est décrit dans [WORKFLOW.md §11](WORKFLOW.md#11-le-sdlc-de-jules-lui-même).

## Mise en route

Il faut Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`) et Docker : les tests lancent un vrai PostgreSQL avec Testcontainers.

```bash
pnpm install
pnpm test
```

| Commande | Effet |
|---|---|
| `pnpm build` | compile chaque package dans `dist/` (Turborepo, dans l'ordre des dépendances) |
| `pnpm typecheck` | vérifie les types de tous les packages, sans build préalable |
| `pnpm lint` | ESLint (règles typées) et Prettier |
| `pnpm format` | reformate avec Prettier |
| `pnpm test` | Vitest dans chaque package |
| `pnpm --filter @jules/worker test` | les tests d'un seul package |
| `pnpm --filter @jules/web e2e` | construit la SPA puis lance les tests Playwright (vraie api, vrai PostgreSQL, Chromium) |
| `pnpm --filter @jules/web dev` et `pnpm --filter @jules/api dev` | l'interface en développement, avec `/v1` relayé vers l'api locale |
| `pnpm db:generate` | génère une migration depuis `packages/db/src/schema.ts` |
| `pnpm jules <commande>` | le CLI d'exploitation, sur les sources (`pnpm jules --help`) |

Pendant le développement, les packages exposent leurs sources TypeScript sous la condition `@jules/source`. Les tests et le typecheck n'attendent donc aucun build. Les images Docker utilisent `dist/`.

## Branches et commits

- La branche `main` est protégée. Tout passe par une PR, avec la CI verte et au moins une review humaine.
- Les messages suivent [Conventional Commits](https://www.conventionalcommits.org/) (`feat(worker): …`, `fix(gateway): …`), vérifiés par commitlint en CI.
- Une PR traite un sujet. Si elle touche une décision structurante, elle ajoute ou modifie un ADR dans `docs/adr/`.

## Tests

- Tout code de production arrive avec ses tests. Les tests qui touchent la base utilisent une vraie base PostgreSQL (`startTestDatabase()` de `@jules/db/testing`), jamais un mock.
- Les invariants de sécurité ont chacun leur test : signature et rejeu des webhooks, chaîne d'audit, chiffrement des secrets, permissions de la GitHub App, `org_id` sur chaque table.
- `packages/policy`, `packages/workflow` et `packages/risk` (à partir de M1 et M2) exigent **100 % de couverture**. Ce seuil est appliqué par leur config Vitest.
- Un changement de prompt, de modèle ou de règle passe d'abord par la suite d'evals (à partir de M5).
- Un changement de `packages/ui` passe la checklist de [DESIGN.md §12](DESIGN.md#12-vérification). Si un écran change volontairement, régénère ses captures (`pnpm --filter @jules/web exec playwright test -c e2e --update-snapshots`), regarde-les, puis relance sans l'option : elles doivent passer telles quelles. Avant la première exécution : `pnpm --filter @jules/web exec playwright install chromium`.

## Base de données

- Le schéma est dans `packages/db/src/schema.ts`. Une migration se génère avec `pnpm db:generate`, puis se relit.
- Chaque nouvelle table porte un `org_id` non nul ([ADR 0013](ARCHITECTURE.md#23-décisions-à-formaliser-docsadr)). Un test le vérifie.
- Une migration publiée ne se modifie plus. On corrige par une nouvelle migration.
- Les triggers et le SQL écrit à la main vont dans une migration `--custom` (`pnpm --filter @jules/db exec drizzle-kit generate --custom`).

## Effets et audit

- Une transition n'appelle jamais GitHub directement. Elle écrit un effet avec `enqueueEffect()`, dans sa transaction, avec une clé d'idempotence. Chaque exécuteur d'effet doit pouvoir être rejoué sans doublon.
- Chaque décision et chaque changement d'état écrit une ligne d'audit avec `appendAudit()`, dans la même transaction. L'audit ne contient que des identifiants internes, jamais un login, un e-mail ni une valeur secrète.

## Dépendances

- Les versions sont épinglées (`save-exact`). Renovate propose les mises à jour, et les actions GitHub sont épinglées par SHA.
- osv-scanner tourne en CI sur `pnpm-lock.yaml`. Une vulnérabilité connue bloque la PR.
- Toute nouvelle dépendance est justifiée dans la PR.

## Versions et images

- Le versionnage suit semver, avec un changelog tenu à partir de la première version publiée.
- Les images de sandbox (M1) sont publiées avec leur SBOM et une signature (cosign). Le worker refuse une image non signée.

## Chemins sensibles

Une PR qui touche `packages/policy`, `packages/workflow`, `packages/risk`, `prompts/`, `packages/db/migrations/` ou `deploy/` demande une review attentive. Ces chemins sont listés dans `CODEOWNERS` quand le repo a plusieurs mainteneurs.
