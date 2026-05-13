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
: "${API_URL:=/api}"
: "${API_SCOPE:=}"
: "${MOCK_MODE:=false}"

export AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_CLOUD AZURE_AUTHORITY_HOST API_URL API_SCOPE MOCK_MODE

# Render in-place. envsubst is provided by the `gettext` Alpine package.
TMP=$(mktemp)
envsubst '${AZURE_CLIENT_ID} ${AZURE_TENANT_ID} ${AZURE_CLOUD} ${AZURE_AUTHORITY_HOST} ${API_URL} ${API_SCOPE} ${MOCK_MODE}' \
  < "$TEMPLATE" > "$TMP"
mv "$TMP" "$TEMPLATE"

exec "$@"
