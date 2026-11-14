#!/bin/sh
# Reads Docker secret files into the environment skylight-mcp expects, then
# execs supergateway. Secret values are never printed.
set -eu

read_secret() {
  # Fails (non-zero) when the file is missing or empty.
  [ -s "/run/secrets/$1" ] || return 1
  cat "/run/secrets/$1"
}

require_secret() {
  if ! value="$(read_secret "$1")" || [ -z "$value" ]; then
    echo "entrypoint: required secret '$1' is missing or empty (/run/secrets/$1)" >&2
    exit 1
  fi
  printf '%s' "$value"
}

SKYLIGHT_EMAIL="$(require_secret skylight_email)"
SKYLIGHT_PASSWORD="$(require_secret skylight_password)"
MCP_CONFIRM_SECRET="$(require_secret mcp_confirm_secret)"
export SKYLIGHT_EMAIL SKYLIGHT_PASSWORD MCP_CONFIRM_SECRET

# Stateful: supergateway starts one skylight-mcp child per client session.
# Stateless would spawn one per request and lose an in-flight emailed-login-code
# flow. Bind loopback only; the local override sets GATEWAY_HOST=0.0.0.0.
exec /app/node_modules/.bin/supergateway \
  --stdio "node /app/node_modules/skylight-mcp/dist/index.js" \
  --outputTransport streamableHttp \
  --stateful \
  --sessionTimeout "${SESSION_TIMEOUT_MS:-1800000}" \
  --host "${GATEWAY_HOST:-127.0.0.1}" \
  --port 8001 \
  --streamableHttpPath /mcp \
  --logLevel info
