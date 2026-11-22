#!/usr/bin/env bash
# Local acceptance tests 1-5 against the local override (no Tailscale, no auth
# proxy, dummy credentials). The image build itself runs the type-check and
# node --test. Tests 6-17 need the NAS / claude.ai; see README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_TOOLS="${EXPECTED_TOOLS:-106}"
PROJECT=skylight-smoke
TEST_IMAGE=skylight-mcp-nas:test
DUMMY="$(mktemp -d)"
COMPOSE=(docker compose -p "$PROJECT" -f compose.yaml -f compose.local.yaml)

cleanup() {
  SECRETS_DIR="$DUMMY" "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DUMMY"
}
trap cleanup EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Dummy secret files; not real credentials. Readable by the container's node user.
for f in skylight_email skylight_password mcp_confirm_secret; do
  echo "dummy-$f" > "$DUMMY/$f"
done
printf 'TS_AUTHKEY=REPLACE_ME\n' > "$DUMMY/ts.env"
printf 'EXTERNAL_URL=https://skylight.example.ts.net\n' > "$DUMMY/proxy.env"
printf 'PROXY_BEARER_TOKEN=REPLACE_ME\n' > "$DUMMY/proxy_token.env"
# Client tokens must be at least 32 characters.
IXL_TOKEN=dummy-client-token-ixl-nas-0000000000000000
printf '%s' dummy-client-token-auth-proxy-000000000000 > "$DUMMY/client_token_auth_proxy"
printf '%s' "$IXL_TOKEN" > "$DUMMY/client_token_ixl_nas"
chmod 755 "$DUMMY"; chmod 644 "$DUMMY"/*

echo "== Build: type-check and node --test run inside the image build"
docker build -q --target test -t "$TEST_IMAGE" . >/dev/null
pass "image build, type-check and tests"

echo "== Test 1: gateway starts with dummy credentials, lists tools, hides blocked tools"
SECRETS_DIR="$DUMMY" "${COMPOSE[@]}" up --build -d skylight
CONTAINER="$(SECRETS_DIR="$DUMMY" "${COMPOSE[@]}" ps -q skylight)"
for _ in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:8001/healthz && break
  sleep 1
done
smoke_client() {
  docker run --rm --network "container:$CONTAINER" -v "$PWD/scripts:/app/scripts:ro" "$@" \
    "$TEST_IMAGE" node scripts/smoke-client.ts http://127.0.0.1:8001/mcp
}
out="$(smoke_client -e GATEWAY_TOKEN="$IXL_TOKEN")" || fail "smoke client: $out"
count="${out%% *}"
[ "$count" = "$EXPECTED_TOOLS" ] || fail "expected $EXPECTED_TOOLS tools, got: $out"
pass "$out"

echo "== Test 2: no credential in image layers, env defaults or tracked files"
IMAGE="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
if { docker history --no-trunc "$IMAGE"; docker inspect "$IMAGE"; } | grep -Eiq 'SKYLIGHT_(EMAIL|PASSWORD)=|MCP_CONFIRM_SECRET=|dummy-skylight|dummy-mcp|dummy-client-token'; then
  fail "credential-like value found in image metadata"
fi
files="$(git ls-files --cached --others --exclude-standard | grep -v '^scripts/smoke-test.sh$')"
# shellcheck disable=SC2086
if grep -InE 'dummy-(skylight|mcp|client-token)' $files; then
  fail "dummy credential value leaked into repo files"
fi
# Env-style files may only hold REPLACE_ME values; secret files must be empty.
# shellcheck disable=SC2086
if grep -InE '^[A-Z_]+=' $(printf '%s\n' $files | grep -E '\.env$') | grep -v 'REPLACE_ME'; then
  fail "non-placeholder value in an env file"
fi
if find secrets.example -type f ! -name '*.env' -size +0 | grep -q .; then
  fail "secrets.example placeholder file is not empty"
fi
pass "no credentials in image or repo"

# The auth proxy appends the request path to its backend URL, so a path here
# turns /mcp into /mcp/mcp (404 on the NAS, invisible locally).
grep -q '"--", "http://127.0.0.1:8001"\]' compose.yaml || fail "auth backend URL in compose.yaml must have no path"
pass "auth proxy backend URL has no path"

echo "== Test 3: /mcp needs a client token; /healthz doesn't"
mcp_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8001/mcp "$@" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
}
[ "$(mcp_status)" = 401 ] || fail "/mcp without a token did not return 401"
[ "$(mcp_status -H 'authorization: Bearer wrong-token-000000000000000000000000')" = 401 ] \
  || fail "/mcp with a wrong token did not return 401"
[ "$(mcp_status -H "authorization: Basic $(printf 'x:%s' "$IXL_TOKEN" | base64)")" = 401 ] \
  || fail "/mcp with Basic auth did not return 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8001/healthz)" = 200 ] || fail "/healthz is not open"
if out="$(smoke_client 2>&1)"; then fail "smoke client without GATEWAY_TOKEN succeeded: $out"; fi
pass "no, wrong and Basic token refused (401); /healthz open; smoke client without a token refused"

echo "== Test 4: empty secret makes the container exit non-zero before the gateway starts"
SECRETS_DIR="$PWD/secrets.example" "${COMPOSE[@]}" down >/dev/null 2>&1 || true
set +e
log="$(SECRETS_DIR="$PWD/secrets.example" "${COMPOSE[@]}" run --rm --no-deps skylight 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "container started with empty secrets"
printf '%s' "$log" | grep -q "required secret" || fail "no clear error message: $log"
printf '%s' "$log" | grep -q "gateway: listening" && fail "gateway started despite empty secret"
pass "entrypoint refused empty secret (exit $rc)"

# Valid Skylight secrets, empty client token: the gateway's own refusal.
mkdir "$DUMMY/empty-token"
cp "$DUMMY"/*.env "$DUMMY"/skylight_* "$DUMMY"/mcp_confirm_secret "$DUMMY"/client_token_* "$DUMMY/empty-token/"
: > "$DUMMY/empty-token/client_token_ixl_nas"
chmod 755 "$DUMMY/empty-token"; chmod 644 "$DUMMY/empty-token"/*
set +e
log="$(SECRETS_DIR="$DUMMY/empty-token" "${COMPOSE[@]}" run --rm --no-deps skylight 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "gateway started with an empty client token"
printf '%s' "$log" | grep -q "client token" || fail "no clear client token error: $log"
printf '%s' "$log" | grep -q "gateway: listening" && fail "gateway started despite empty client token"
pass "gateway refused empty client token (exit $rc)"

echo "== Test 5: npm audit finds no known vulnerabilities"
docker run --rm "$TEST_IMAGE" npm audit --audit-level=low >/dev/null || fail "npm audit reported vulnerabilities"
pass "npm audit clean"

echo "All local acceptance tests passed."
