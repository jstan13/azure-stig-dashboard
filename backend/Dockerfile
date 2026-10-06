# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Every workspace manifest is needed for `npm ci` to validate the lockfile,
# even though only the backend is installed.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY functions/package.json ./functions/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspace=backend

# Copy backend source
COPY backend/ ./backend/

# Build TypeScript
RUN npm run build --workspace=backend

# Re-resolve without dev dependencies, still pinned by the lockfile. The mkdir
# guarantees the workspace folder exists for the COPY below even when npm
# hoisted everything.
RUN npm ci --omit=dev --ignore-scripts --workspace=backend && mkdir -p backend/node_modules

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy built artifacts and minimal packages. npm nests a backend dependency
# under backend/node_modules when another workspace needs a different version
# at the root, so overlay those to give the backend exactly what it declares.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/package.json ./
COPY --from=builder /app/backend/openapi.yaml ./

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
