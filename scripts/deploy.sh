#!/usr/bin/env bash
# Deploys an existing tag to the NAS: check it out, rebuild, wait for the
# gateway to report healthy. Also the rollback command: deploy the previous tag.
#   scripts/deploy.sh v0.1.2
# Reads NAS_HOST and NAS_USER from .nas-setup.env (written by nas-setup.sh).
# sudo on the NAS asks for your DSM password once.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?usage: scripts/deploy.sh <tag>}"
NAS_REPO_DIR=/volume1/docker/skylight-mcp-nas

[[ -f .nas-setup.env ]] || { echo "deploy: no .nas-setup.env; run scripts/nas-setup.sh first" >&2; exit 1; }
# shellcheck source=/dev/null
. ./.nas-setup.env
NAS="${NAS_USER:?}@${NAS_HOST:?}"

git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null \
  || { echo "deploy: tag $TAG is not on GitHub" >&2; exit 1; }

# One script, one SSH session, so sudo asks once. Synology's sudo PATH lacks
# /usr/local/bin, hence the absolute docker path.
remote=$(cat <<EOF
set -eu
cd '$NAS_REPO_DIR'
git fetch --quiet --tags --force origin
previous=\$(git describe --tags --exact-match 2>/dev/null || echo none)
git -c advice.detachedHead=false checkout --quiet 'refs/tags/$TAG'
DOCKER=\$(command -v docker || echo /usr/local/bin/docker)
echo "deploy: \$previous -> $TAG; building (tests run inside the build)"
sudo "\$DOCKER" compose up -d --build
container=\$(sudo "\$DOCKER" compose ps -q skylight)
status=starting
for _ in \$(seq 1 30); do
  status=\$(sudo "\$DOCKER" inspect --format '{{.State.Health.Status}}' "\$container")
  [ "\$status" = healthy ] && break
  sleep 2
done
if [ "\$status" != healthy ]; then
  echo "deploy: skylight is \$status, not healthy. Logs:" >&2
  sudo "\$DOCKER" compose logs --tail 40 skylight >&2
  echo "deploy: roll back with: scripts/deploy.sh \$previous" >&2
  exit 1
fi
echo "deploy: $TAG is live and healthy."
echo "deploy: roll back with: scripts/deploy.sh \$previous"
EOF
)
# Sent base64-encoded so no quoting depends on the NAS login shell; sudo reads
# the password from the terminal ssh -t allocates, not from the pipe.
ssh -t "$NAS" "echo $(printf '%s' "$remote" | base64 | tr -d '\n') | base64 -d | bash"
