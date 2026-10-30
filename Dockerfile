FROM node:24-bookworm

# System dependencies + DB clients (servers live in the compose stack on the
# reinvent-dbs network — see docker-compose.dbs.yml).
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  postgresql-client \
  default-mysql-client \
  && rm -rf /var/lib/apt/lists/*

# pnpm 10 — the estate's standard Node package manager (PRD toolchain).
# Installed globally rather than via corepack: corepack's per-user cache
# doesn't survive the root→agent user switch below.
RUN npm install -g pnpm@10

# Issue tracker: Notion, accessed via its REST API with curl + jq (installed
# above) through .sandcastle/tracker.sh — no extra CLI needed. Requires
# NOTION_TOKEN in .sandcastle/.env.

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# uv + Python 3.13 — the estate's standard Python toolchain (PRD).
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
  /home/agent/.local/bin/uv python install 3.13

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude + uv to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# Pre-fetch pnpm dependencies into the global store for fast, offline sandbox installs.
# We only copy the lockfile so this cache layer only invalidates when dependencies change.
WORKDIR /tmp/pnpm-cache
COPY pnpm-lock.yaml ./
RUN pnpm fetch

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
