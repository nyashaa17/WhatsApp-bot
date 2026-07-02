# syntax=docker/dockerfile:1

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps stage: install full workspace deps (needed for pnpm workspace linking) ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY scripts/package.json scripts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build stage ----
FROM deps AS build
COPY . .
RUN pnpm --filter @workspace/api-server... run build

# ---- production deps only (smaller image) ----
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @workspace/api-server...

# ---- final runtime image ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=prod-deps /app/lib ./lib
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json

# Persistent volume mount point for the Baileys WhatsApp session.
# Set BAILEYS_AUTH_PATH=/data/baileys-auth and mount a volume there in Coolify.
RUN mkdir -p /data/baileys-auth

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
