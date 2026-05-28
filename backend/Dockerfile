# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root and backend manifests
COPY package.json ./
COPY backend/package.json ./backend/

# Install backend dependencies
RUN npm install --workspace=backend

# Copy backend source
COPY backend/ ./backend/

# Build TypeScript
RUN npm run build --workspace=backend

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy built artifacts and minimal packages
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/package.json ./
COPY --from=builder /app/backend/openapi.yaml ./

# Install production-only deps
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
