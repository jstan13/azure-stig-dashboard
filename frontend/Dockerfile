# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

ARG VITE_AZURE_CLIENT_ID
ARG VITE_AZURE_TENANT_ID
ARG VITE_API_URL=/api
ARG VITE_API_SCOPE
ARG VITE_MOCK_MODE=false

WORKDIR /app

COPY package.json ./
COPY frontend/package.json ./frontend/

RUN npm install --workspace=frontend

COPY frontend/ ./frontend/

# Vite uses ARG env vars at build time
RUN VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID \
    VITE_AZURE_TENANT_ID=$VITE_AZURE_TENANT_ID \
    VITE_API_URL=$VITE_API_URL \
    VITE_API_SCOPE=$VITE_API_SCOPE \
    VITE_MOCK_MODE=$VITE_MOCK_MODE \
    npm run build --workspace=frontend

# ── Stage 2: Production nginx ─────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
