# skylight-mcp-nas

Serves [skylight-mcp](https://www.npmjs.com/package/skylight-mcp) from a Synology NAS so claude.ai and OpenCode can use the family's Skylight from anywhere, at `https://skylight.<tailnet>.ts.net/mcp`, behind a GitHub sign-in limited to one account.

```
client (claude.ai, OpenCode)
  ─► ts        Tailscale Funnel, public HTTPS on 443        ─► 127.0.0.1:8000
  ─► auth      mcp-auth-proxy, GitHub sign-in (one account)  ─► 127.0.0.1:8001/mcp
  ─► skylight  our gateway (src/server.ts): one process, one Skylight sign-in
```

All three containers share the `ts` container's network namespace. No host ports are published.

Terms (Skylight server, gateway, Skylight sign-in, verification code, gated write tool, confirm gate, …) are defined in [GLOSSARY.md](GLOSSARY.md). Decisions:

- [ADR 0001](docs/adr/0001-own-gateway-instead-of-supergateway.md): our own gateway instead of supergateway, so every MCP session shares one Skylight sign-in.
- [ADR 0002](docs/adr/0002-server-side-tool-blocklist.md): admin write tools are blocked in the server ([src/blocked-tools.ts](src/blocked-tools.ts)), for every client.

## Pinned versions

| Component | Pin |
| --- | --- |
| skylight-mcp | 1.6.2 |
| @chrischall/mcp-utils | 3.9.0 (skylight-mcp accepts `^3.7.2`; upstream tested 1.6.2 with 3.7.2) |
| @modelcontextprotocol/server, /node, /client | 2.4.0, 2.1.2, 2.4.0 |
| TypeScript, @types/node | 7.0.2, 26.6.6 (type-check only) |
| Base image | `node:26.13.1-slim@sha256:e6bedef2…` (Node runs `src/*.ts` directly) |
| Tailscale | `tailscale/tailscale:v1.104.4` |
| Auth proxy | `ghcr.io/sigbit/mcp-auth-proxy:v2.10.2` |

The lockfile must come from the image's npm (11.20.0). To change a pin, edit `package.json` and regenerate:

```bash
IMG=node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
rm -f package-lock.json
docker run --rm -v "$PWD:/w" -w /tmp $IMG sh -c '
  cp /w/package.json . && npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
  rm -rf node_modules && npm ci --ignore-scripts --no-audit >/dev/null
  cp package-lock.json /w/ && chown $(stat -c %u:%g /w) /w/package-lock.json'
```

On a skylight-mcp upgrade, also compare `node_modules/skylight-mcp/dist/index.js` with [src/skylight.ts](src/skylight.ts) (registrar list, `makeGetClient`) and check that every name in `src/blocked-tools.ts` still exists. The gateway refuses to start if a blocked tool is missing, but it can't catch a new admin tool.

## Develop and test locally

Use Node 26 (`nvm use` reads `.nvmrc`).

```bash
npm ci
npm run typecheck      # tsc 7, no emit
npm test               # node --test: blocked tools, shared Skylight sign-in (fake Skylight, no network)
./scripts/smoke-test.sh
```

`smoke-test.sh` builds the image (the build itself runs the type-check and tests), then runs local acceptance tests 1 to 4 with dummy secrets: 106 tools listed with the 10 blocked tools absent, no credential in the image or repo, an empty secret stops the entrypoint before the gateway starts, and `npm audit` is clean. It uses `compose.local.yaml`, which disables `ts` and `auth` and publishes `127.0.0.1:8001`.

## First-time NAS setup

You need: DSM 7.2+ with **Container Manager** and **Git Server** (Package Center), SSH on (Control Panel → Terminal & SNMP), and this repo **public** on GitHub (the NAS clones it over plain HTTPS; nothing in it is secret).

1. **Run the wizard on your laptop:** `scripts/nas-setup.sh`. It walks you through:
   1. SSH key login to the NAS (sets it up if needed)
   2. checking the NAS (DSM version, the `docker` folder, git, docker)
   3. cloning the repo into `/volume1/docker/skylight-mcp-nas`
   4. Tailscale: tailnet name, MagicDNS, HTTPS certificates, Funnel in the policy file
   5. a Tailscale auth key
   6. a GitHub OAuth app
   7. your Skylight email and password, plus a generated confirm secret
   8. file ownership (sudo)

   Secrets go from a hidden prompt straight into `/volume1/docker/secrets/skylight` on the NAS over SSH. They are never written on your laptop. Non-secret answers (NAS address, tailnet name, GitHub username) are saved in `.nas-setup.env` (gitignored). Re-running keeps existing secrets unless you choose to replace one.
2. **Ship the first version:** `scripts/release.sh` (see below). Choose `minor` to get `v0.1.0`.
3. **Disable key expiry:** at <https://login.tailscale.com/admin/machines>, click `skylight` → … → Disable key expiry.
4. **Add the claude.ai connector:** Settings → Connectors → Add custom connector → URL `https://skylight.<tailnet>.ts.net/mcp` → Connect, then sign in with GitHub. The 10 admin tools are already gone. Use the connector's tool switches for anything else you don't want claude.ai to call.
5. **First Skylight sign-in:** in claude.ai, ask Claude to run `skylight_healthcheck`. If Skylight emails a verification code, give it to Claude to submit with `skylight_submit_login_code`. Any client and any chat can submit it, because all MCP sessions share one Skylight sign-in. The token cache in `data/` carries over restarts and redeploys.
6. **OpenCode:** replace the local `npx` skylight entry in your OpenCode config with the hosted one, then run `opencode mcp auth skylight` to sign in with GitHub:

   ```json
   "skylight": { "type": "remote", "url": "https://skylight.<tailnet>.ts.net/mcp" }
   ```

   Don't keep both. A local `npx` copy has its own Skylight sign-in, and the two would trigger verification codes against each other. Whether OpenCode's OAuth flow works with mcp-auth-proxy is not yet tested.

## Shipping a change

After a change is on `main` (merged from a PR, or committed locally on `main`):

1. `git checkout main && git pull`, then `git push origin main` if you committed locally; `release.sh` refuses to run until `main` matches GitHub.
2. `scripts/release.sh`. It:
   1. refuses unless `main` is clean and matches `origin/main`
   2. runs the smoke test
   3. shows the commits since the last tag and asks patch, minor or major
   4. creates and pushes the tag
   5. deploys it with `scripts/deploy.sh` (sudo on the NAS asks for your DSM password once)
   6. waits until the gateway reports healthy
3. Check that claude.ai still lists the Skylight tools.

Use **patch** for fixes and pin bumps, **minor** for new behavior, **major** for anything that needs a new setup step.

## Rollback

- **Previous version:** `scripts/deploy.sh <previous tag>`. Both scripts print the exact command after a deploy. `data/` and `auth-data/` are kept.
- **Take it off the internet now:** `ssh ericmasiello@192.168.4.49 'sudo /usr/local/bin/docker exec skylight-mcp-nas-ts-1 tailscale funnel reset'`
- **Stop everything:** `ssh -t ericmasiello@192.168.4.49 'cd /volume1/docker/skylight-mcp-nas && sudo /usr/local/bin/docker compose down'`, then remove the claude.ai connector.

## Confirm gates and blocked tools

`MCP_CONFIRM_MODE=ask-user` and `MCP_CONFIRM_ELICITATION=off` are set in the image. Never set `MCP_CONFIRM_MODE=auto`. A gated write tool first returns a preview and a confirm token; Claude must get your approval in chat before repeating the call with the token. Tokens are signed with `mcp_confirm_secret`, and spent tokens are recorded in `data/`, so the gate works across requests and restarts.

Most write tools are not gated: single deletes such as `skylight_delete_event` run immediately. The admin tools listed in `src/blocked-tools.ts` are removed from the server entirely (ADR 0002).

## Rotation

- **Skylight password:** run `scripts/nas-setup.sh` again and replace `skylight_password`, then `scripts/deploy.sh <current tag>`. Delete `data/.skylight-mcp/tokens.json` on the NAS if the old sign-in misbehaves.
- **`mcp_confirm_secret`:** replace it the same way and redeploy. Outstanding confirm tokens stop working.
- **GitHub client secret:** regenerate it in GitHub, replace `proxy.env` with the wizard, redeploy. Deleting `auth-data/` invalidates every issued OAuth token and signing key.
- **Tailscale key:** only needed on first join; later starts use `ts-state/`.

## Acceptance tests

| # | Test | Where |
| --- | --- | --- |
| 1 to 4 | `./scripts/smoke-test.sh` | laptop (passes) |
| 5 | `curl -i https://skylight.<tailnet>.ts.net/mcp` from off the tailnet → 401; `curl https://skylight.<tailnet>.ts.net/.well-known/oauth-protected-resource` → 200 JSON | NAS |
| 6 | GitHub sign-in: your account gets in, another account is refused | NAS |
| 7 to 10 | `skylight_healthcheck`; `skylight_list_lists` and `skylight_list_events` return real data; `skylight_clear_list` on a test list returns a preview only (don't confirm); redeploy and repeat test 7 with no new verification code | claude.ai |
| 11 | claude.ai lists events, shows none of the blocked tools, and asks before any write | claude.ai |

## Verified and not yet verified

- **Verified locally:** the gateway serves 106 tools on Node 26 from a read-only, non-root container; separate clients share one Skylight sign-in (a test against a fake Skylight sees 1 login for 5 concurrent clients, and 5 when sharing is deliberately broken); blocked tools are neither listed nor callable; no known vulnerabilities.
- **mcp-auth-proxy v2.10.2** returns 401 without a `WWW-Authenticate` header but serves `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, and supports dynamic client registration at `POST /.idp/register`. Its GitHub callback is `{EXTERNAL_URL}/.auth/github/callback`. It appends the incoming path to the backend URL, so the backend in `compose.yaml` must be `http://127.0.0.1:8001` with no path; `…/mcp` there makes every claude.ai call a 404 at `/mcp/mcp`. Whether claude.ai finds the sign-in flow without the header is only proven by test 11.
- **Not yet run:** anything on the NAS, the Tailscale container, the real Skylight sign-in and verification code, and OpenCode's OAuth flow.
- **If claude.ai can't finish the OAuth flow:** use `tailscale serve` (tailnet only) instead of Funnel, or put a different OAuth proxy in front. Never ship a public endpoint protected only by a secret path.
