# ── Stage 1: Build ────────────────────────────────────────────────────────────
# The published image is identical for every deployer. Per-tenant config
# (client id, tenant id, API URL, etc.) is injected at container START via
# /runtime-config.js + envsubst, NOT baked into the bundle.
FROM node:26-alpine AS builder

WORKDIR /app

COPY package.json ./
COPY frontend/package.json ./frontend/

RUN npm install --workspace=frontend

COPY frontend/ ./frontend/

# Build with empty Vite env vars — the bundle reads window.__APP_CONFIG__ at runtime.
RUN VITE_MOCK_MODE=false npm run build --workspace=frontend

# ── Stage 2: Production nginx ─────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# This base image defaults to uid 101; apk and the chmod/chown below need root.
USER root

# envsubst (from gettext) is used by the entrypoint to render runtime-config.js
RUN apk add --no-cache gettext

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN chown -R 101:101 /usr/share/nginx/html

# Drop back to the unprivileged nginx user for runtime.
USER 101

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
