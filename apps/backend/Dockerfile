FROM node:20-slim

# ── System dependencies ────────────────────────────────────────────────────────

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ── Docker CLI ────────────────────────────────────────────────────────────────
# Required for sandboxManager.ts to create/manage sandbox containers.
# The Docker daemon runs on the host — this container needs only the CLI client.
# Docker socket is mounted at runtime via docker-compose.
RUN curl -fsSL https://get.docker.com | sh

# ── App setup ─────────────────────────────────────────────────────────────────

WORKDIR /app

# Copy monorepo root files needed for pnpm workspace resolution
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/

# Copy backend source
COPY apps/backend/package.json ./apps/backend/package.json

# Install dependencies (CI-style: frozen lockfile)
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile --filter @ai-hivemind/backend...

# Copy backend source (after install to leverage layer caching)
COPY apps/backend/src/ ./apps/backend/src/
COPY apps/backend/tsconfig.json ./apps/backend/tsconfig.json

WORKDIR /app/apps/backend

# Expose the Nerve Center port
EXPOSE 3001

# Start the server (tsx for development; swap for `node dist/index.js` in prod)
CMD ["npx", "tsx", "src/index.ts"]
