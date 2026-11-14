#!/usr/bin/env bash
# Acceptance tests 1-3 against the local override (no Tailscale, no auth proxy,
# dummy credentials). Tests 4-10 need the NAS / claude.ai; see README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_TOOLS="${EXPECTED_TOOLS:-116}"
PROJECT=skylight-smoke
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
chmod 755 "$DUMMY"; chmod 644 "$DUMMY"/*

echo "== Test 1: server starts with dummy credentials and lists tools"
SECRETS_DIR="$DUMMY" "${COMPOSE[@]}" up --build -d skylight
for _ in $(seq 1 30); do
  curl -s -o /dev/null http://127.0.0.1:8001/mcp && break
  sleep 1
done
out="$(npx -y @modelcontextprotocol/inspector --cli http://127.0.0.1:8001/mcp --transport http --method tools/list)"
count="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tools.length))')"
[ "$count" = "$EXPECTED_TOOLS" ] || fail "expected $EXPECTED_TOOLS tools, got $count"
pass "tools/list returned $count tools"

echo "== Test 2: no credential in image layers, env defaults or tracked files"
IMAGE="$(docker inspect --format '{{.Image}}' "$(SECRETS_DIR="$DUMMY" "${COMPOSE[@]}" ps -q skylight)")"
if { docker history --no-trunc "$IMAGE"; docker inspect "$IMAGE"; } | grep -Eiq 'SKYLIGHT_(EMAIL|PASSWORD)=|MCP_CONFIRM_SECRET=|dummy-skylight|dummy-mcp'; then
  fail "credential-like value found in image metadata"
fi
files="$(git ls-files --cached --others --exclude-standard | grep -v '^scripts/smoke-test.sh$')"
# shellcheck disable=SC2086
if grep -InE 'dummy-(skylight|mcp)' $files; then
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

echo "== Test 3: empty secret makes the entrypoint exit non-zero before supergateway"
SECRETS_DIR="$PWD/secrets.example" "${COMPOSE[@]}" down >/dev/null 2>&1 || true
set +e
log="$(SECRETS_DIR="$PWD/secrets.example" "${COMPOSE[@]}" run --rm --no-deps skylight 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "container started with empty secrets"
printf '%s' "$log" | grep -q "required secret" || fail "no clear error message: $log"
printf '%s' "$log" | grep -qi "supergateway" && fail "supergateway started despite empty secret"
pass "entrypoint refused empty secret (exit $rc)"

echo "All local acceptance tests passed."
