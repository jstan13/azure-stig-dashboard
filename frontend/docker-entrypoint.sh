#!/bin/sh
# Render /usr/share/nginx/html/runtime-config.js from App Service env vars,
# then exec nginx. The published image ships a template with ${VAR} tokens;
# this entrypoint replaces them at container start so the SAME image works for
# every deployer, with their own Entra tenant / client id / API URL.

set -eu

TEMPLATE="/usr/share/nginx/html/runtime-config.js"

# Sensible defaults so MSAL doesn't crash if a deployer forgets to set one.
: "${AZURE_CLIENT_ID:=}"
: "${AZURE_TENANT_ID:=}"
: "${AZURE_CLOUD:=AzureCloud}"
: "${AZURE_AUTHORITY_HOST:=https://login.microsoftonline.com}"
# An origin, not a path. Empty means same-origin, i.e. the nginx /api/ proxy.
: "${API_URL:=}"
: "${API_SCOPE:=}"
: "${MOCK_MODE:=false}"
# Upstream for the nginx /api/ proxy. The compose default only resolves on the
# compose network; App Service supplies the backend's public origin.
: "${BACKEND_ORIGIN:=http://backend:3001}"

export AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_CLOUD AZURE_AUTHORITY_HOST API_URL API_SCOPE MOCK_MODE

# Render in-place. envsubst is provided by the `gettext` Alpine package.
TMP=$(mktemp)
envsubst '${AZURE_CLIENT_ID} ${AZURE_TENANT_ID} ${AZURE_CLOUD} ${AZURE_AUTHORITY_HOST} ${API_URL} ${API_SCOPE} ${MOCK_MODE}' \
  < "$TEMPLATE" > "$TMP"
mv "$TMP" "$TEMPLATE"

# Only ${BACKEND_ORIGIN} is listed, so nginx's own $host, $remote_addr and
# friends survive untouched.
BACKEND_ORIGIN="$BACKEND_ORIGIN" envsubst '${BACKEND_ORIGIN}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec "$@"
