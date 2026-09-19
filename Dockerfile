################################################################################
# calliope-cli — Docker image
#
# Multi-stage build:
#   builder  — compiles TypeScript and prunes to production deps
#   runtime  — minimal Alpine image, non-root user, production-ready
#
# Usage:
#   Interactive:  docker run -it --rm -e ANTHROPIC_API_KEY=... calliope-cli
#   Headless:     docker run --rm -e ANTHROPIC_API_KEY=... calliope-cli calliope --headless
#   API server:   docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=... calliope-cli calliope --serve
################################################################################

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /build

# Install dependencies (all — including devDeps needed for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/verify-runlog.mjs ./scripts/verify-runlog.mjs
RUN npm run build

# Prune to production dependencies only
RUN npm prune --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# git is needed by calliope-cli for project memory / session operations
RUN apk add --no-cache git

# Non-root user with home dir for config persistence
# UID/GID 2000 sidesteps the `node` user that ships at 1000 in node:24-alpine
RUN addgroup -g 2000 calliope && \
    adduser -u 2000 -G calliope -s /bin/sh -D -h /home/calliope calliope

WORKDIR /app

# Copy compiled output and production node_modules from builder
COPY --from=builder --chown=calliope:calliope /build/dist ./dist
COPY --from=builder --chown=calliope:calliope /build/node_modules ./node_modules
COPY --from=builder --chown=calliope:calliope /build/scripts ./scripts
COPY --chown=calliope:calliope package.json ./

# Install the CLI globally so `calliope` is on PATH
RUN npm install -g . --ignore-scripts && \
    chown -R calliope:calliope /usr/local/lib/node_modules /usr/local/bin/calliope

USER calliope

# Fail the image build if the installed CLI cannot start as its runtime user.
RUN calliope --version && calliope doctor --json

# Config persistence: mount a volume here to keep settings across container restarts
VOLUME ["/home/calliope/.config/calliope"]

# Workspace: mount user project directory here
WORKDIR /workspace

# AI provider API keys — pass at runtime via -e or env file
# ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, etc.

# Suppress SDK debug noise in container environments
ENV CALLIOPE_DEBUG=""
ENV NODE_ENV=production
# Allow calliope to detect it's running in a container
ENV CALLIOPE_CONTAINER=1

# Expose API server port (used with `calliope --serve`)
EXPOSE 3000

CMD ["calliope"]
