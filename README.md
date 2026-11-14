# skylight-mcp-nas

Runs [skylight-mcp](https://www.npmjs.com/package/skylight-mcp) 1.6.2 in Docker on a Synology NAS, behind a GitHub OAuth sign-in proxy and a Tailscale Funnel sidecar, so it can be added as a claude.ai custom connector at `https://skylight.<tailnet>.ts.net/mcp`.

```
claude.ai ─► https://skylight.<tailnet>.ts.net/mcp
          ─► ts (Tailscale Funnel, TLS)  ─► 127.0.0.1:8000
          ─► auth (mcp-auth-proxy, GitHub sign-in) ─► 127.0.0.1:8001/mcp
          ─► skylight (supergateway --stateful) ─► one skylight-mcp child per client session (stdio)
```

All three containers share the `ts` container's network namespace. No host ports are published.

## Pinned versions

| Component | Pin |
| --- | --- |
| skylight-mcp | 1.6.2 (`package.json`, `package-lock.json`) |
| supergateway | 4.2.2 |
| Base image | `node:22.23.5-slim@sha256:e9f565d3…` |
| Tailscale | `tailscale/tailscale:v1.104.4` (v1.104.5/6 exist on GitHub but weren't on Docker Hub when pinned) |
| Auth proxy | `ghcr.io/sigbit/mcp-auth-proxy:v2.10.2` |

The lockfile must be generated with the same npm as the image (`npm ci` rejects a lockfile produced by a different npm here). To change a pin, regenerate it in the pinned image:

```bash
IMG=node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
rm -f package-lock.json
docker run --rm -v "$PWD:/w" -w /tmp $IMG sh -c '
  cp /w/package.json . && npm install --ignore-scripts >/dev/null 2>&1
  rm -rf node_modules && npm install --ignore-scripts --package-lock-only >/dev/null 2>&1
  npm ci --ignore-scripts && cp package-lock.json /w/ && chown $(stat -c %u:%g /w) /w/package-lock.json'
```

## What was verified (spec open questions)

| Question | Answer |
| --- | --- |
| One skylight-mcp process for all requests? | **No.** supergateway 4.2.2 stateless mode starts a new child per request; stateful mode starts one child per client session (`stdioToStatelessStreamableHttp.js`, `statefulSessions.js`). The entrypoint uses `--stateful`, so the emailed-login-code flow works inside one Inspector session. Confirm tokens still verify across children because `MCP_CONFIRM_SECRET` is shared. Children share `/data/.skylight-mcp/tokens.json`. |
| Does mcp-auth-proxy do DCR? | **Yes.** `POST /.idp/register` returned 201 for a claude.ai redirect URI; `/.well-known/oauth-authorization-server` lists `registration_endpoint`, S256 PKCE. |
| Backend URL syntax | `command: ["--", "http://127.0.0.1:8001/mcp"]` works (image entrypoint is the binary). For HTTP backends the proxy keeps the backend's own path, so `/mcp` is exposed as `/mcp`. |
| GitHub callback path | `{EXTERNAL_URL}/.auth/github/callback` |
| 401 `WWW-Authenticate` header | **Not emitted.** v2.10.2 returns `401 {"error":"Unauthorized"}` with no `WWW-Authenticate`, but serves `/.well-known/oauth-protected-resource` and the authorization-server metadata. Acceptance test 4 is therefore: 401, and 200 JSON from the protected-resource URL. Whether claude.ai discovers the flow without the header is only proven by test 10. The proxy lists Claude Web as verified. |
| 2026-07-28 stateless revision through supergateway | supergateway's README says it supports legacy MCP and 2026-07-28, and falls back for clients that negotiate. Stateful mode keeps legacy sessions. The local test (Inspector over HTTP) passed. Not exercised against claude.ai. |
| Frames / plan type / blocked tools | Still open for you; see the end. |

## Local test (no Tailscale, no real credentials)

```bash
./scripts/smoke-test.sh
```

Runs acceptance tests 1 to 3 with temporary dummy secrets: 116 tools listed, no credential in the image or repo, and an empty secret makes the entrypoint exit 1 before supergateway starts. It uses `compose.local.yaml`, which disables `ts` and `auth` and publishes `127.0.0.1:8001` only.

## NAS setup (you)

### 1. Folders and secrets

Over DSM SSH:

```bash
sudo mkdir -p /volume1/docker/skylight-mcp-nas /volume1/docker/secrets/skylight
# copy this repo into /volume1/docker/skylight-mcp-nas, then:
cd /volume1/docker/skylight-mcp-nas
sudo mkdir -p data ts-state auth-data
sudo chown 1000:1000 data                       # skylight runs as node (UID 1000)

cd /volume1/docker/secrets/skylight
# skylight_email, skylight_password: your Skylight login. No trailing newline needed.
printf '%s' 'you@example.com'   | sudo tee skylight_email    >/dev/null
printf '%s' 'REAL_PASSWORD'     | sudo tee skylight_password >/dev/null
openssl rand -hex 32 | tr -d '\n' | sudo tee mcp_confirm_secret >/dev/null
# proxy.env and ts.env: start from secrets.example/*.env and fill in (steps 2 and 3)
sudo chown 1000:1000 skylight_email skylight_password mcp_confirm_secret
sudo chmod 400 skylight_* mcp_confirm_secret proxy.env ts.env
sudo chmod 700 .
```

Keep the secrets folder out of any browsable DSM shared folder and out of Synology Drive sync. Back it up only to an encrypted destination. Docker reads `env_file` as root, so `proxy.env` and `ts.env` can stay root-owned.

### 2. GitHub OAuth app

github.com/settings/developers → New OAuth App:
- Homepage URL: `https://skylight.<tailnet>.ts.net`
- Callback URL: `https://skylight.<tailnet>.ts.net/.auth/github/callback`

Put these in `proxy.env`: `EXTERNAL_URL=https://skylight.<tailnet>.ts.net`, `GITHUB_ALLOWED_USERS=<your handle>`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

### 3. Tailscale

Admin console: MagicDNS and HTTPS certificates on; allow Funnel for this device in the policy file (`nodeAttrs` with `funnel`). Create a one-time, non-ephemeral, untagged auth key and put it in `ts.env` as `TS_AUTHKEY=…`. After the machine `skylight` joins, disable key expiry on it. Your tailnet name is in `TS_CERT_DOMAIN`; `serve.json` uses it, so nothing in the repo needs editing.

### 4. Deploy

Container Manager → Project → Create from `/volume1/docker/skylight-mcp-nas`. Or over SSH:

```bash
cd /volume1/docker/skylight-mcp-nas && sudo docker compose up -d --build
sudo docker exec skylight-mcp-nas-ts-1 tailscale funnel status
```

### 5. First Skylight login

```bash
npx @modelcontextprotocol/inspector   # open the UI, transport: Streamable HTTP, URL: https://skylight.<tailnet>.ts.net/mcp
```

Sign in with GitHub, then call `skylight_healthcheck`. If it reports `verification_code_required`, call `skylight_submit_login_code` with the emailed code **in the same Inspector session** (the pending login lives in that session's child process). The token cache in `./data` carries later starts.

### 6. claude.ai connector

Customize → Connectors → Add custom connector → URL `https://skylight.<tailnet>.ts.net/mcp` → Sign in. Then, in the connector's tool settings, block tools you never want called from chat, for example `skylight_remove_user`, `skylight_delete_category`, `skylight_link_apple_calendar`.

## Confirm-gated writes

`MCP_CONFIRM_MODE=ask-user` and `MCP_CONFIRM_ELICITATION=off` are baked into the image. claude.ai can't show elicitation prompts, so gated writes use the two-step preview plus `confirmToken` flow; Claude must get your approval in chat before repeating the call. Never set `MCP_CONFIRM_MODE=auto`. Single deletes such as `skylight_delete_event` are not gated, so block risky tools in the connector settings.

## OpenCode

Leave the existing local `skylight` entry exactly as it is. To try the hosted server, add a second entry that stays disabled by default:

```json
"skylight-hosted": {
  "type": "remote",
  "url": "https://skylight.<tailnet>.ts.net/mcp",
  "disabled": true
}
```

OpenCode runs the OAuth flow with DCR on first use; `opencode mcp auth skylight-hosted` starts it by hand. Enable only one of the two entries per project: both expose the same tool names, and each logs in to Skylight separately against a rate-limited endpoint, which can trigger emailed login codes. The hosted server keeps `MCP_CONFIRM_ELICITATION=off` permanently; the local entry can drop it once OpenCode PR #53608 lands.

## Acceptance tests

| # | Test | Where |
| --- | --- | --- |
| 1 to 3 | `./scripts/smoke-test.sh` | laptop (passes) |
| 4 | `curl -i https://skylight.<tailnet>.ts.net/mcp` from off the tailnet → 401; `curl https://skylight.<tailnet>.ts.net/.well-known/oauth-protected-resource` → 200 JSON (no `WWW-Authenticate`, see above) | NAS |
| 5 | Inspector OAuth: your GitHub account succeeds, another is refused | NAS |
| 6 to 9 | `skylight_healthcheck`; `skylight_list_lists` and `skylight_list_events`; `skylight_clear_list` on a test list **without** a token (preview only, don't send the token); restart `skylight` and repeat test 6 with no new emailed code | NAS |
| 10 | claude.ai lists events; Claude asks before any write | claude.ai |

## Rotation and rollback

- **Skylight password:** edit `skylight_password`, `sudo docker compose up -d --force-recreate skylight`. Delete `data/.skylight-mcp/tokens.json` if the old token misbehaves.
- **`mcp_confirm_secret`:** replace and recreate `skylight`. Outstanding preview tokens stop verifying.
- **GitHub client secret:** regenerate in GitHub, edit `proxy.env`, recreate `auth`. Deleting `auth-data/` invalidates every issued OAuth token and signing key.
- **Tailscale key:** only needed on first join; later restarts use `ts-state/`.
- **Rollback:** `sudo docker compose down` and remove the connector. To go back to the previous version, check out the earlier commit and `up -d --build`; `data/` and `auth-data/` are kept. To take the endpoint off the internet immediately: `sudo docker exec skylight-mcp-nas-ts-1 tailscale funnel reset`.
- **Fallbacks** if claude.ai can't finish the OAuth flow: supergateway `--apiKey` plus a claude.ai Request header, if offered; otherwise `tailscale serve` only and use it from your tailnet. Never ship a secret-path-only public endpoint.

## Still open for you

- Does the Skylight account have more than one frame? If so, add `SKYLIGHT_FRAME_ID` (a third secret or an `environment:` entry on `skylight`).
- Pro/Max (you add the connector) or Team (an Owner adds it)?
- Which tools to block in the connector from day one?
