# syntax=docker/dockerfile:1
# Images du gateway et du worker, construites depuis la racine du monorepo :
#   docker build -f deploy/Dockerfile --target gateway -t jules-gateway .
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@jules/gateway... --filter=@jules/worker...
RUN pnpm --filter=@jules/gateway deploy --prod --legacy /out/gateway \
 && pnpm --filter=@jules/worker deploy --prod --legacy /out/worker

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS gateway
COPY --from=build --chown=root:root /out/gateway .
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=root:root /out/worker .
CMD ["node", "dist/main.js"]
