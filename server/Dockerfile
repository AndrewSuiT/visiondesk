# ==============================================================================
# VisionDesk Central Server & Relay Core - Multi-stage Dockerfile
# Base: node:22-alpine (Target: Ubuntu Server 22.04 LTS VPS)
# RAM Target: < 30 MB idle RSS | Container Limit: 64 MB
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Dependency Builder
# ------------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Install dependencies with frozen lockfile, excluding devDependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# ------------------------------------------------------------------------------
# Stage 2: Minimal Production Runner
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

# Set production environment variables
ENV NODE_ENV=production \
    PORT=8080 \
    RELAY_PORT=8080 \
    HOST=0.0.0.0 \
    NODE_OPTIONS="--max-old-space-size=64"

WORKDIR /app

# Ensure proper non-root permissions for the node user
RUN chown -R node:node /app

# Copy production node_modules from deps stage
COPY --chown=node:node --from=deps /app/node_modules ./node_modules

# Copy application source code
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js relay.js registry.js users-manager.js* users.json* manage-users.js* ./
COPY --chown=node:node public ./public

# Switch to non-root user
USER node

# Expose server ports (8080 default, 8081 if separate relay port configured)
EXPOSE 8080 8081

# Container Healthcheck (BusyBox wget has ~1MB memory overhead)
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/api/health > /dev/null || exit 1

# Launch production server
CMD ["node", "server.js"]
