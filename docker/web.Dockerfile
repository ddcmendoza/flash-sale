# The flash-sale web app, as the one-command demo runs it: the Vite dev server.
#
# A dev server, not a production bundle, and that is the point rather than a
# shortcut. The SPA has no CORS configuration anywhere, and it does not need one:
# the browser loads the app from Vite on :5173 and Vite proxies /api to the API,
# so every request the browser makes is same-origin. Serving a `vite build`
# artefact from a separate static origin (nginx, `vite preview` on another port)
# would break exactly that property and force CORS into a project that
# deliberately has none — changing the shipped architecture to suit the demo
# harness. It would also mean the demo you show is not the code the tests run.
#
# Vite is started with --host 0.0.0.0 in the compose command; without it the dev
# server binds the container's loopback and the host browser cannot reach it.
#
# Build context is the repo root (npm workspaces).
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=development

# The web workspace needs the shared contracts and the root dev dependencies
# (vite, tsx); the server and e2e manifests have to be present for npm to
# resolve the workspace graph.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/e2e/package.json apps/e2e/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund

COPY apps/web apps/web
COPY packages packages
# apps/web/tsconfig.json extends this one. Vite resolves it through esbuild's
# tsconfig loader and warns loudly without it — and the failure surfaces as a
# 500 on the entry module, not as a failed container start, so it has to be in
# the image.
COPY tsconfig.base.json tsconfig.base.json

EXPOSE 5173

CMD ["npm", "run", "dev", "-w", "@flash-sale/web", "--", "--host", "0.0.0.0"]
