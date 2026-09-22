# The flash-sale API server under test, built as a standalone image. The
# benchmark harness (stress/docker/run.sh) runs this container pinned to a
# fixed CPU share and memory budget so Locust results are comparable across
# machines instead of reflecting whatever the host happened to have free.
#
# Build context is the repo root (npm workspaces: shared + server).

FROM node:22-bookworm-slim
WORKDIR /app

# tsx (root devDependency) is the server's runtime; the full npm ci links the
# `@flash-sale/shared` workspace too. Workspace manifests must exist before
# install so npm resolves the graph.
COPY package.json package-lock.json .
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci -s

# Source (no build step for server code; tsx runs it directly).
COPY apps apps
COPY packages packages

EXPOSE 3000
USER node
CMD ["npx", "tsx", "apps/server/src/index.ts"]