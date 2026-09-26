# The flash-sale API, as the one-command demo runs it.
#
# Deliberately the same runtime as local development and as the benchmark
# container: TypeScript executed directly by tsx, with no compile step and no
# bundler. There is no build artefact in this project to copy into an image, and
# inventing one (tsc -> dist -> node dist/) would create a second code path that
# nothing else runs and therefore nothing else tests. `npm run dev:server` and
# this image execute the same files through the same loader.
#
# Build context is the repo root (npm workspaces: shared + server + web).

FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=development

# Workspace manifests must exist before install so npm resolves the graph; the
# lockfile is what makes the install reproducible.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund

COPY apps/server apps/server
COPY packages packages
# Both workspace tsconfigs extend the root one, and Vite/esbuild reads it while
# transforming the SPA. Without it Vite still serves index.html and still answers
# 200 on /, so a missing app looks healthy right up until the browser asks for
# the entry module and gets a 500.
COPY tsconfig.base.json tsconfig.base.json
# The schema is applied at startup, and db/schema.ts resolves it relative to its
# own source file, so the SQL has to travel with the code.
COPY infra/db infra/db

EXPOSE 3000

# The demo's database is created by the compose healthcheck-gated dependency, so
# this container only has to apply the schema, seed the demo sales, and then
# serve. `db:migrate` is idempotent, so this is also the right thing to run on
# every restart of an existing stack.
CMD ["sh", "-c", "npm run migrate -w @flash-sale/server && exec npx tsx apps/server/src/index.ts"]
