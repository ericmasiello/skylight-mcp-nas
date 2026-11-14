#!/bin/sh
# Reads Docker secret files into the environment skylight-mcp expects, then
# execs the gateway. Secret values are never printed.
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

# The gateway binds loopback unless GATEWAY_HOST says otherwise; the local
# override sets 0.0.0.0.
exec node /app/src/server.ts
