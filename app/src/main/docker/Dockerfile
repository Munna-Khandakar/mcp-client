ARG UBUNTU_VERSION=24.04
ARG NODE_VERSION=20

ARG USER_UID=1000
ARG USER_GID=1000
ARG USER_HOME=/app

# ───────────────────────────────
# Stage 1: Application Builder with Ubuntu 24.04
# ───────────────────────────────
FROM ubuntu:${UBUNTU_VERSION} AS builder
ARG UBUNTU_VERSION
ARG NODE_VERSION

ARG USER_UID
ARG USER_GID
ARG USER_HOME

SHELL ["/bin/bash", "-oeux", "pipefail", "-c"]

# System setup and package installation and Install Node.js and Npm
RUN apt-get update \
    && apt-get upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
        ca-certificates curl \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION%%.*}.x | bash - \
    && apt-get install -y nodejs \
    && npm install --global npm@latest \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Application setup
WORKDIR ${USER_HOME}

# Copy only package files first for layer caching
COPY ./dist/package*.json ./

# Use npm ci for reproducible builds
RUN npm ci

# Copy application source
COPY ./dist/src ./src
COPY ./dist/tsconfig.json ./

RUN npm run build

# Install production dependencies
RUN npm ci --omit=dev

# ───────────────────────────────
# Stage 2: Final runtime image
# ───────────────────────────────
FROM ideascale/node:latest AS runtime

ARG USER_HOME=/app
ARG USER_UID=1000
ARG USER_GID=1000

WORKDIR ${USER_HOME}

# Copy compiled app and dependencies from builder
COPY --from=builder --chown=${USER_UID}:${USER_GID} ${USER_HOME}/dist ${USER_HOME}/dist
COPY --from=builder --chown=${USER_UID}:${USER_GID} ${USER_HOME}/node_modules ${USER_HOME}/node_modules
COPY --from=builder --chown=${USER_UID}:${USER_GID} ${USER_HOME}/package.json ${USER_HOME}/package.json
COPY --from=builder --chown=${USER_UID}:${USER_GID} ${USER_HOME}/package-lock.json ${USER_HOME}/package-lock.json
COPY --from=builder --chown=${USER_UID}:${USER_GID} ${USER_HOME}/tsconfig.json ${USER_HOME}/tsconfig.json

# Switch to non-root user
USER ${USER_UID}:${USER_GID}

# Expose application port (update if needed)
EXPOSE 3078

# Set environment variable (optional)
ENV NODE_ENV=production

# Run the app
CMD [ "node", "dist/index.js" ]