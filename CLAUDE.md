# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Milestones **M0–M4 are implemented**: issue → triage → spec → design (human gates H1/H2 per risk and autonomy) → developer in a gVisor sandbox → push → draft PR → verification gates replayed by the worker → AI review on another model (G6, COMMENT review, `Jules / review` check run, traceability matrix in the PR) → human review, with `/jules fix` and "Request changes" looping back to the developer, plus `@jules setup` onboarding; then the learner proposes lessons that a human approves (`/jules lesson approve`) and that are injected into later tasks. `jules report` computes the WORKFLOW §10 metrics, `jules eval run|compare` gates prompt changes on the eval suite in `evals/`, and retention purging runs hourly. Étape 1 (the core, M0–M5) is complete. **M6 is implemented**: `apps/api` (GitHub OAuth sessions, Jules roles capped by the GitHub permission, CSRF, passkey step-up, sealed-box write-only secrets, SSE) and the web UI (`packages/ui` + `apps/web`), where every button becomes a pending `commands` row that the worker re-checks and applies through the same engine as GitHub. M7 (DevOps agent) is next. The design documents are written in French; keep that language when editing them, and use French for user-facing strings and code comments, matching the existing code.

| File | Role |
|---|---|
| `README.md` | one-page pitch and doc index |
| `ARCHITECTURE.md` | components, trust zones, sandbox, capabilities (`mcp__jules__*` tools), SSH execution, GitHub App, config, data model, reliability (§17), personal data and retention (§18), threat model (§19), stack (§20), monorepo layout (§21), ADR list (§23), open questions (§24) |
| `WORKFLOW.md` | agent lifecycles: the 9-phase developer state machine (§2), risk/ceremony classification (§3), gates (§5), artifacts (§6), `/jules` commands (§7), DoR/DoD, DevOps (§12) and Security (§13) workflows |
| `ROADMAP.md` | pre-M0 decisions, Étape 1 core M0–M5, Étape 2 1.0 M6–M11, Étape 3 extensions, risks. Every milestone has deliverables and a Definition of Done |
| `DESIGN.md` | web and desktop UI, built on the user's `warm-dark-ui` skill (`~/.claude/skills/warm-dark-ui`): token setup, colour semantics, screens, Jules-specific components, accessibility, verification |
| `CONTRIBUTING.md` | rules for the Jules repo itself: commands, commits, tests, migrations, dependencies |
| `deploy/README.md` | server runbook: secrets, GitHub App creation, compose, backups, key rotation |

The documents cross-reference one another by section anchor (e.g. `ARCHITECTURE.md#14-données-postgresql`). When you renumber or rename a section, update the links that point to it in the other files. Jules is modelled on Boubou (https://boubou.evolueoo.com/docs/architecture). `ARCHITECTURE.md §22` lists the deliberate differences.

## What Jules is

Jules is a self-hosted platform that runs three agents: **Developer** (issue → spec → design → TDD → verification gates → second-model review → PR), **DevOps** (operates servers over SSH and proposes ChangePlans), and **Security** (audits and tracks findings). Users drive it from three interfaces: GitHub, a web SPA, and a Tauri desktop app. All three send the same commands to one engine (`packages/commands`).

## Invariants every design change must preserve

These principles come from ARCHITECTURE.md §2 and WORKFLOW.md §1. Any new feature or doc edit has to stay consistent with them:

- The agent is untrusted. It runs in a disposable gVisor container with **no secrets**. It can only call broker capabilities, and the worker performs every effect (push, PR, server change). Intent is kept separate from effect.
- Policy, phase transitions and gates are tested deterministic code, never prompts. Anything not explicitly allowed is denied. An LLM never validates its own work.
- Deterministic checks (build, lint, types, tests, scans) run before any LLM review. The worker re-runs them in a fresh container, so no claim from the agent is trusted.
- Config, gate commands, playbooks and conventions are read from the default branch, never from the agent's branch.
- External content (issues, comments, repo files, server output) is data, never instructions.
- Everything is bounded (cost, time, iterations, review rounds) and recorded in a hash-chained audit log that contains no secret values.
- No agent merges, no agent sees a secret, production always requires human approval, and the GitHub App has no `workflows` permission.
- PostgreSQL is the only datastore. It also holds the job queue (pg-boss) and realtime notifications (LISTEN/NOTIFY). There is no Redis.
- Every table carries an `org_id`. Every side effect (GitHub call, push, notification) goes through the `outbox` table with an idempotency key. An interrupted server action is never replayed automatically.
- Sensitive actions (production approval, secrets, raising autonomy, accepting a risk, lifting the emergency stop) require a passkey at the time of the action, so they are web/desktop only by default.
- UI work follows `DESIGN.md` and the `warm-dark-ui` skill: components use token roles, never hex values.

## Commands

Requires Node 24, pnpm 10 and Docker (tests start a real PostgreSQL through Testcontainers).

```bash
pnpm install
pnpm test                               # Vitest in every package (turbo)
pnpm --filter @jules/worker test        # one package
pnpm --filter @jules/worker exec vitest run test/e2e.test.ts   # one file
pnpm typecheck                          # tsc per package, no build needed
pnpm lint                               # ESLint (type-aware) + Prettier check
pnpm build                              # tsc to dist/, in dependency order
pnpm db:generate                        # migration from packages/db/src/schema.ts
pnpm jules --help                       # operations CLI (migrate, secrets, audit verify, reconcile, report, purge, eval, stop --all)
JULES_TEST_SKIP_BUILD=1 pnpm --filter @jules/worker exec vitest run test/sandbox-e2e.test.ts  # reuse built test images
pnpm --filter @jules/web e2e            # vite build + Playwright (e2e/server.ts: Testcontainers Postgres, real api, fake GitHub OAuth)
pnpm --filter @jules/web exec playwright test -c e2e --update-snapshots   # only when a screen changes on purpose; then re-run without it
```

`pnpm lint` needs about 5 GB of heap (type-aware ESLint over every project), which the script sets through `NODE_OPTIONS`.

The worker's sandbox tests build `jules-sandbox-node:test` and `jules-egress:test` from `deploy/Dockerfile` (cached by Docker) and run the real Claude Code binary against a scripted fake model (`apps/worker/test/fake-model.ts`). They use `runc` locally; set `JULES_SANDBOX_RUNTIME=runsc` where gVisor is installed.

## Code layout and conventions

- Workspace packages export their TypeScript sources under the custom condition `@jules/source` (see `tsconfig.base.json` and `vitest.shared.ts`), so tests and typecheck never need a build; `dist/` is only for Docker images. Dev scripts run through `tsx`.
- ESM with `nodenext`: relative imports end in `.js`. TypeScript is pinned to 6.0.x because typescript-eslint does not support 7 yet.
- `apps/gateway`: Fastify app that verifies the HMAC, dedups on `X-GitHub-Delivery`, stores into `events` and answers 202. It holds only the webhook secret.
- `apps/worker`: `inbox.ts` (claims events, network reads first, then one transaction writing task + outbox + audit + event status), `outbox.ts` (idempotent effect executors, ordered per `serial_key`), `reconcile.ts` (redelivers GitHub deliveries missing from `events`), `worker.ts` (LISTEN/NOTIFY loop plus slow polling; refuses to start if the GitHub App has a forbidden permission), `cli.ts` (`jules` CLI).
- `apps/worker/src/broker/`: one Fastify server per run on a Unix socket mounted into that run's sandbox (`/run/jules/broker.sock`); `capabilities.ts` (zod validation, limits, `policy.decide`, tool_calls + audit in one transaction) and `model-proxy.ts` (swaps the run token for the real key, counts tokens and cost, enforces the budget, masks secrets, detects provider outages).
- `apps/worker/src/orchestrator.ts`: claims a task, clones a worker-only "pristine" bare repo, runs the sandbox, exports commits with `git bundle` in a network-less container, checks `policy.decide({action:"push"})`, then writes push + draft PR + status effects in one transaction. `recover()` handles crashes.
- `apps/worker/src/verification.ts` + `packages/gates`: diff-level gates run in the worker on the pristine clone (pure analyzers in `packages/gates`); repo commands run in a fresh verification container that does its own checkout of the pushed commit from the pristine mounted read-only. Config is always read from the default branch.
- `packages/sandbox`: Docker driver (per-run internal network with `gateway_mode_ipv4=isolated`, hardened container, per-run egress proxy reached by IP) and the dependency-free egress proxy.
- `packages/agent-runner`: sandbox entrypoint; Agent SDK `query()` with `settingSources: []`, `strictMcpConfig`, an `env` that replaces everything, and the in-process `jules` MCP server that forwards to the broker.
- `packages/policy`, `packages/workflow` (state machine: `transition(ctx, event)`), `packages/risk` and `packages/commands` (`/jules` parsing and required rights) are pure, with 100% coverage enforced by their Vitest config. `packages/artifacts` holds the zod schemas shared by broker and agent-runner (capability inputs, Triage/Spec/Design with gates G1–G3). Prompts live in `prompts/<role>/vN.md`, with shared rules in `prompts/_common.md`.
- `apps/worker/src/transitions.ts`: the only way to change a task's state (`applyTransition`: optimistic version check, status effect and audit in one transaction). `conversation.ts` turns issue comments into commands or answers.
- `packages/forge`: the `GitHubApp` port, the Octokit implementation (installation tokens scoped to the repo and permissions of each call), and `FakeGitHub` in `@jules/forge/testing`, which delivers real signed webhooks over HTTP.
- Tests that touch the database use `startTestDatabase()` from `@jules/db/testing`, never a mock. `audit_log` is append-only, so tests filter it by target instead of truncating it.
- The audit PII guard rejects keys like `name`, `login`, `email` in audit `data`: use internal IDs and neutral keys (`command`, `role`).
- `apps/api`: `buildApi()` in `app.ts` (strict CSP, security headers, static SPA with fallback), `session.ts` (`guard(options, role, { stepUp })`, `sessionOf`), `oauth.ts`, `passkeys.ts` (SimpleWebAuthn, step-up valid 5 minutes), `routes.ts`. The api holds no runtime secret: writes become pending `commands` rows (LISTEN channel `jules_commands`) or outbox effects, and the worker (`web-commands.ts`) re-checks rights against GitHub before applying them.
- `packages/ui`: the shared React app (`JulesApp`, TanStack Router + Query, i18next with `locales/fr.json` and `en.json` that must keep identical keys), with the skill's tokens copied verbatim in `styles/tokens.css` and recipes plus Jules components in `styles/jules.css`. Agent-written content is rendered as text only; `test/guards.test.ts` forbids injected HTML and hex colours outside `tokens.css`. `apps/web` is only the Vite entry; its Playwright suite lives in `apps/web/e2e` with reference screenshots in `e2e/__screenshots__`.
- Still to come, as planned in ARCHITECTURE.md §21: `apps/desktop`, `packages/ssh`, `packages/devops`, `packages/security`. In Jules's own repo, `packages/policy`, `packages/workflow`, `packages/risk` and `prompts/` are high-risk paths (WORKFLOW.md §11), and any change to a prompt, model or rule must pass the eval suite first.
