# syntax=docker/dockerfile:1
# Images de Jules, construites depuis la racine du monorepo :
#   docker build -f deploy/Dockerfile --target gateway -t jules-gateway .
# Cibles : gateway, worker, egress (un par exécution), sandbox-node (agent-runner).
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
# Dépendances d'abord : elles ne sont retéléchargées que si le lockfile change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build \
      --filter=@jules/gateway... --filter=@jules/worker... --filter=@jules/agent-runner... --filter=@jules/sandbox
RUN pnpm --filter=@jules/gateway deploy --prod --legacy /out/gateway \
 && pnpm --filter=@jules/worker deploy --prod --legacy /out/worker \
 && pnpm --filter=@jules/agent-runner deploy --prod --legacy /out/agent-runner \
 && cp -r prompts /out/worker/prompts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

FROM runtime AS gateway
COPY --from=build --chown=root:root /out/gateway .
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM runtime AS worker
# git : clone pristine et push, jamais dans un workspace modifié par un agent (ARCHITECTURE.md §8).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=root:root /out/worker .
ENV JULES_PROMPTS_DIR=/app/prompts
USER node
CMD ["node", "dist/main.js"]

# Egress proxy d'une exécution : un seul fichier, sans dépendance.
FROM runtime AS egress
COPY --from=build --chown=root:root /repo/packages/sandbox/dist/egress-proxy.js /app/egress-proxy.js
USER node
CMD ["node", "/app/egress-proxy.js"]

# Sandbox pour les repos Node : l'agent-runner, git, curl. Aucun secret, aucune clé.
FROM ${NODE_IMAGE} AS sandbox-node
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=root:root /out/agent-runner /opt/jules/agent-runner
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/jules/agent-runner/dist/main.js"]
