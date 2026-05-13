// Runtime configuration injected by the container entrypoint at startup.
// The placeholder tokens (e.g. ${AZURE_CLIENT_ID}) are replaced by `envsubst`
// from App Service environment variables before nginx serves this file.
//
// During `vite build` / local `npm run dev` this file is copied verbatim and
// the placeholders remain as-is. The runtime-config helper detects unresolved
// placeholders and falls back to Vite build-time env vars in that case.
window.__APP_CONFIG__ = {
  AZURE_CLIENT_ID:      "${AZURE_CLIENT_ID}",
  AZURE_TENANT_ID:      "${AZURE_TENANT_ID}",
  AZURE_CLOUD:          "${AZURE_CLOUD}",
  AZURE_AUTHORITY_HOST: "${AZURE_AUTHORITY_HOST}",
  API_URL:              "${API_URL}",
  API_SCOPE:            "${API_SCOPE}",
  MOCK_MODE:            "${MOCK_MODE}"
};
