# skylight-mcp-nas

Serves [skylight-mcp](https://www.npmjs.com/package/skylight-mcp) from a Synology NAS so claude.ai and OpenCode can use the family's Skylight from anywhere, at `https://skylight.<tailnet>.ts.net/mcp`, behind a GitHub sign-in limited to one account.

```
client (claude.ai, OpenCode)
  ─► ts        Tailscale Funnel, public HTTPS on 443        ─► 127.0.0.1:8000
  ─► auth      mcp-auth-proxy, GitHub sign-in (one account)  ─► 127.0.0.1:8001/mcp, with its own client token
  ─► skylight  our gateway (src/server.ts): checks the client token; one process, one Skylight sign-in

ixl-nas (own tailnet device) ─► skylight:8001/mcp over the tailnet, with its client token ─► skylight
```

All three containers share the `ts` container's network namespace. No host ports are published. The gateway refuses every `/mcp` request without a known client token, so the auth proxy sends its own in place of the user's GitHub token, and a tailnet device can't reach the tools around the GitHub sign-in.

Terms (Skylight server, gateway, Skylight sign-in, verification code, gated write tool, confirm gate, …) are defined in [GLOSSARY.md](GLOSSARY.md). Decisions:

- [ADR 0001](docs/adr/0001-own-gateway-instead-of-supergateway.md): our own gateway instead of supergateway, so every MCP session shares one Skylight sign-in.
- [ADR 0002](docs/adr/0002-server-side-tool-blocklist.md): admin write tools are blocked in the server ([src/blocked-tools.ts](src/blocked-tools.ts)), for every client.
- [ADR 0003](docs/adr/0003-client-tokens-on-the-gateway.md): every `/mcp` request needs a client token, one per client ([src/client-tokens.ts](src/client-tokens.ts)), and the tailnet policy lets only ixl-nas reach the gateway port.

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

ixl-nas calls `skylight_resolve_member` and `skylight_create_chore` headlessly. Check that both still exist, are not in `src/blocked-tools.ts`, keep their input fields (`skylight_resolve_member`: `name`, `frameId?`; `skylight_create_chore`: `summary`, `category_id`, `start?`, `description?`, `reward_points?`, `frameId?`), and that `skylight_create_chore` has not gained a confirm gate (a `confirmToken` parameter): ixl-nas can't answer one. If any of that changes, update ixl-nas before deploying. A test in `test/gateway.test.ts` checks the names, the main fields and the missing gate, so a bump that breaks them fails the image build.

## Develop and test locally

Use Node 26 (`nvm use` reads `.nvmrc`).

```bash
npm ci
npm run typecheck      # tsc 7, no emit
npm test               # node --test: blocked tools, shared Skylight sign-in, client tokens, ixl-nas's tools (fake Skylight, no network)
./scripts/smoke-test.sh
```

`smoke-test.sh` builds the image (the build itself runs the type-check and tests), then runs local acceptance tests 1 to 5 with dummy secrets: 106 tools listed with the 10 blocked tools absent, no credential in the image or repo, `/mcp` refuses no, wrong and `Basic` tokens while `/healthz` stays open, an empty secret or client token stops the container before the gateway listens, and `npm audit` is clean. The smoke client reads its token from `GATEWAY_TOKEN` (`GATEWAY_TOKEN=… node scripts/smoke-client.ts http://127.0.0.1:8001/mcp`), never from the command line. It uses `compose.local.yaml`, which disables `ts` and `auth` and publishes `127.0.0.1:8001`.

## First-time NAS setup

You need: DSM 7.2+ with **Container Manager** and **Git Server** (Package Center), SSH on (Control Panel → Terminal & SNMP), and this repo **public** on GitHub (the NAS clones it over plain HTTPS; nothing in it is secret).

1. **Run the wizard on your laptop:** `scripts/nas-setup.sh`. It walks you through:
   1. SSH key login to the NAS (sets it up if needed)
   2. checking the NAS (DSM version, the `docker` folder, git, docker)
   3. cloning the repo into `/volume1/docker/skylight-mcp-nas`
   4. Tailscale: tailnet name, MagicDNS, HTTPS certificates, and the tailnet policy (tags, grants, Funnel; see [Tailnet policy](#tailnet-policy))
   5. a Tailscale auth key, tagged `tag:skylight` (tagged devices have key expiry off)
   6. a GitHub OAuth app
   7. your Skylight email and password, plus a generated confirm secret
   8. client tokens, generated for the auth proxy and ixl-nas
   9. file ownership (sudo)

   Secrets go from a hidden prompt straight into `/volume1/docker/secrets/skylight` on the NAS over SSH. They are never written on your laptop. Non-secret answers (NAS address, tailnet name, GitHub username) are saved in `.nas-setup.env` (gitignored). Re-running keeps existing secrets unless you choose to replace one.
2. **Ship the first version:** `scripts/release.sh` (see below). Choose `minor` to get `v0.1.0`.
3. **Add the claude.ai connector:** Settings → Connectors → Add custom connector → URL `https://skylight.<tailnet>.ts.net/mcp` → Connect, then sign in with GitHub. The 10 admin tools are already gone. Use the connector's tool switches for anything else you don't want claude.ai to call.
4. **First Skylight sign-in:** in claude.ai, ask Claude to run `skylight_healthcheck`. If Skylight emails a verification code, give it to Claude to submit with `skylight_submit_login_code`. Any client and any chat can submit it, because all MCP sessions share one Skylight sign-in. The token cache in `data/` carries over restarts and redeploys.
5. **OpenCode:** point the `skylight` server at the hosted URL (OpenCode V2 shape; in Eric's setup this lives in `ericmasiello-skills`' two `opencode.json` files):

   ```jsonc
   "mcp": { "servers": { "skylight": { "type": "remote", "url": "https://skylight.<tailnet>.ts.net/mcp" } } }
   ```

   Then run `/mcps` in OpenCode, select `skylight` and sign in with GitHub. Don't keep a local `npx skylight-mcp` entry too: it would have its own Skylight sign-in, and the two would trigger verification codes against each other.

## Client tokens

A client token is the secret a client sends to the gateway as `Authorization: Bearer <token>` on every `/mcp` request (ADR 0003). Each client has its own, as a Docker secret named `client_token_<client>`:

| Client | Secret | Sent by |
| --- | --- | --- |
| auth proxy (claude.ai, OpenCode) | `client_token_auth_proxy` | mcp-auth-proxy, from `PROXY_BEARER_TOKEN` in `proxy_token.env` (same value; the wizard writes both at once) |
| ixl-nas | `client_token_ixl_nas` | ixl-nas, which copies it on the NAS into its own secrets as `skylight_token` |

The gateway reads every `client_token_*` file at start and refuses to start with none, or with one that is empty, shorter than 32 characters, or a duplicate. A request without a known token gets 401 with `WWW-Authenticate: Bearer realm="skylight-gateway"` and a `gateway: refused /mcp (missing|scheme|unknown)` log line; tokens are never logged. `/healthz` needs no token.

- **Add a client:** add a `client_token_<name>` secret to `compose.yaml` (top-level `secrets:` and the `skylight` service's list), add a generating entry to the "Client tokens" stage of `scripts/nas-setup.sh`, its name to the ownership stage, and to `REQUIRED_SECRETS` in `scripts/deploy.sh`. Then run the wizard and redeploy.
- **Revoke a client:** delete its file in `/volume1/docker/secrets/skylight`, remove it from `compose.yaml`, the wizard and `deploy.sh`, and redeploy. To cut it off without removing it, replace the token with the wizard and redeploy.

## Tailnet policy

The client token is the first lock; the tailnet policy at <https://login.tailscale.com/admin/acls/file> is the second. All of Eric's devices are owned by one login, so the policy tells `skylight` and `ixl-nas` apart by tag:

```hujson
"tagOwners": {
  "tag:skylight": ["autogroup:admin"],
  "tag:ixl-nas":  ["autogroup:admin"],
},
"grants": [
  // Eric's own devices keep reaching each other as before.
  {"src": ["autogroup:member"], "dst": ["autogroup:member"], "ip": ["*"]},
  // The public URL over the tailnet: OpenCode on the laptop resolves it to the tailnet IP.
  {"src": ["autogroup:member"], "dst": ["tag:skylight"], "ip": ["tcp:443"]},
  // The gateway, for ixl-nas only.
  {"src": ["tag:ixl-nas"], "dst": ["tag:skylight"], "ip": ["tcp:8001"]},
],
"nodeAttrs": [{"target": ["tag:skylight"], "attr": ["funnel"]}],
"tests": [
  {"src": "tag:ixl-nas", "accept": ["tag:skylight:8001"], "deny": ["tag:skylight:443"]},
  {"src": "<your login email>", "accept": ["tag:skylight:443"], "deny": ["tag:skylight:8001"]},
],
```

- **Why tags:** with `TS_USERSPACE=true`, Tailscale forwards inbound tailnet TCP to `127.0.0.1:<port>`, so without a policy any tailnet device reaches the gateway on 8001. Tagging `skylight` and `ixl-nas` lets one grant open 8001 to ixl-nas alone. Tagged devices have key expiry off, so no "disable key expiry" step is needed.
- **Why 443 stays open to your devices:** MagicDNS resolves `skylight.<tailnet>.ts.net` to the tailnet IP on tailnet devices, so OpenCode on the laptop reaches port 443 over the tailnet, not through Funnel.
- **Why Funnel targets the tag:** tagged devices are not in `autogroup:member`, so a Funnel attribute for `autogroup:member` stops applying the moment `skylight` is tagged. Funnel traffic (claude.ai, and OpenCode off the tailnet) doesn't go through the grants; only this attribute applies to it.
- **The default allow-all rule must go,** in either form: `"acls": [{"action": "accept", "src": ["*"], "dst": ["*:*"]}]` or `"grants": [{"src": ["*"], "dst": ["*"], "ip": ["*"]}]`. Keep everything else already in the policy. An exit node or subnet routes need their own grant (`autogroup:internet`).
- ixl-nas reaches the gateway in plain HTTP inside WireGuard, so its client token never leaves the tailnet.

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

### Upgrading to client tokens (from v0.1.x)

The order matters: the gateway must not demand a token the auth proxy isn't sending yet, and tagging `skylight` before the policy is ready breaks Funnel.

1. **Push:** the change is on `main`, then `git push origin main`.
2. **Write the token files:** run `scripts/nas-setup.sh` and keep every existing secret. Skip its stage 4 policy edit (steps 5 to 7 below do it in a safe order). The new stage writes `proxy_token.env`, `client_token_auth_proxy` and `client_token_ixl_nas`, and the ownership stage sets their owners. Nothing running reads them yet.
3. **Ship:** `scripts/release.sh`. Its smoke test covers test 3, then `deploy.sh` checks that the three token files exist before it rebuilds, and waits for health. One `docker compose up` recreates `auth` and `skylight` together.
4. **Check claude.ai and OpenCode:** run tests 13 and 14 right away. If claude.ai gets 401s, roll back with `scripts/deploy.sh v0.1.1`.
5. **Prepare the policy:** add the `tagOwners` and a `nodeAttrs` Funnel entry for `tag:skylight`, keeping the existing `autogroup:member` one for now. Save.
6. **Tag the devices:** Machines → device → … → Edit ACL tags: `skylight` gets `tag:skylight`, `ixl-nas` gets `tag:ixl-nas`. No new sign-in is needed, and `ts-state/` keeps working. Check that Funnel still answers (test 6).
7. **Lock down the tailnet:** replace the allow-all rule with the grants and `tests` from [Tailnet policy](#tailnet-policy), and drop the `autogroup:member` Funnel entry. Save; the policy's `tests` must pass.
8. **Run tests 15 to 17.**

## Rollback

- **Previous version:** `scripts/deploy.sh <previous tag>`. Both scripts print the exact command after a deploy. `data/` and `auth-data/` are kept. Rolling back to `v0.1.1` removes the token check; the token files stay unused and harmless. The tailnet policy doesn't depend on the version.
- **Take it off the internet now:** `ssh ericmasiello@192.168.4.49 'sudo /usr/local/bin/docker exec skylight-mcp-nas-ts-1 tailscale funnel reset'`
- **Stop everything:** `ssh -t ericmasiello@192.168.4.49 'cd /volume1/docker/skylight-mcp-nas && sudo /usr/local/bin/docker compose down'`, then remove the claude.ai connector.

## Confirm gates and blocked tools

`MCP_CONFIRM_MODE=ask-user` and `MCP_CONFIRM_ELICITATION=off` are set in the image. Never set `MCP_CONFIRM_MODE=auto`. A gated write tool first returns a preview and a confirm token; Claude must get your approval in chat before repeating the call with the token. Tokens are signed with `mcp_confirm_secret`, and spent tokens are recorded in `data/`, so the gate works across requests and restarts.

Most write tools are not gated: single deletes such as `skylight_delete_event` run immediately. The admin tools listed in `src/blocked-tools.ts` are removed from the server entirely (ADR 0002).

## Rotation

- **Skylight password:** run `scripts/nas-setup.sh` again and replace `skylight_password`, then `scripts/deploy.sh <current tag>`. Delete `data/.skylight-mcp/tokens.json` on the NAS if the old sign-in misbehaves.
- **`mcp_confirm_secret`:** replace it the same way and redeploy. Outstanding confirm tokens stop working.
- **GitHub client secret:** regenerate it in GitHub, replace `proxy.env` with the wizard, redeploy. Deleting `auth-data/` invalidates every issued OAuth token and signing key.
- **Client tokens:** run `scripts/nas-setup.sh` again and replace the token at the "Client tokens" stage, then `scripts/deploy.sh <current tag>`. For `client_token_ixl_nas`, re-copy it into ixl-nas (its own `nas-setup.sh`) and redeploy ixl-nas too; until then ixl-nas gets 401. Replacing the auth proxy's token rewrites both of its files, and the redeploy restarts both containers.
- **Tailscale key:** only needed on first join; later starts use `ts-state/`.

## Acceptance tests

| # | Test | Where |
| --- | --- | --- |
| 1 to 5 | `./scripts/smoke-test.sh` (3: no, wrong and `Basic` token on `/mcp` → 401, `/healthz` → 200, smoke client without a token exits 1) | laptop (passes) |
| 6 | `curl -i https://skylight.<tailnet>.ts.net/mcp` from off the tailnet → 401; `curl https://skylight.<tailnet>.ts.net/.well-known/oauth-protected-resource` → 200 JSON | NAS |
| 7 | GitHub sign-in: your account gets in, another account is refused | NAS |
| 8 to 11 | `skylight_healthcheck`; `skylight_list_lists` and `skylight_list_events` return real data; `skylight_clear_list` on a test list returns a preview only (don't confirm); redeploy and repeat test 8 with no new verification code | claude.ai |
| 12 | claude.ai lists events, shows none of the blocked tools, and asks before any write | claude.ai |
| 13 | `skylight_healthcheck` and `skylight_list_events` return real data, as before (proves the auth proxy sends its client token) | claude.ai |
| 14 | **Bypass closed:** `curl -i -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' http://skylight:8001/mcp` → `401` with `WWW-Authenticate: Bearer`; `curl http://skylight:8001/healthz` → `ok` | laptop on the tailnet, before the policy change |
| 15 | OpenCode: `/mcps` lists the `skylight` tools (over the tailnet to 443), no new sign-in | laptop |
| 16 | **Policy:** `curl -m 5 http://skylight:8001/healthz` → timeout; `curl -i https://skylight.<tailnet>.ts.net/mcp` → `401` from the laptop and from a phone off Wi-Fi with Tailscale off | laptop, phone |
| 17 | **ixl-nas reaches the gateway through its proxy:** `ssh -t <nas> 'sudo /usr/local/bin/docker exec -e http_proxy=http://127.0.0.1:1055 ixl-nas-ts-1 wget -qO- http://skylight:8001/healthz'` → `ok`; the same with `wget -S --post-data` and test 14's initialize body, no token → `401` | NAS |

A call **with** the ixl-nas token is proven by ixl-nas's daily check-in job, not here, so the token is never copied anywhere just to test it.

## Verified and not yet verified

- **Verified locally:** the gateway serves 106 tools on Node 26 from a read-only, non-root container; separate clients share one Skylight sign-in (a test against a fake Skylight sees 1 login for 5 concurrent clients, and 5 when sharing is deliberately broken); blocked tools are neither listed nor callable; `/mcp` refuses requests without a known client token, each client token is accepted, and the gateway won't start with a missing, empty or short one; the tools ixl-nas calls keep their contract; no known vulnerabilities.
- **mcp-auth-proxy v2.10.2** returns 401 without a `WWW-Authenticate` header but serves `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, and supports dynamic client registration at `POST /.idp/register`. Its GitHub callback is `{EXTERNAL_URL}/.auth/github/callback`. It appends the incoming path to the backend URL, so the backend in `compose.yaml` must be `http://127.0.0.1:8001` with no path; `…/mcp` there makes every claude.ai call a 404 at `/mcp/mcp`. Whether claude.ai finds the sign-in flow without the header is only proven by test 11.
- **Verified on the NAS (v0.1.1):** the Tailscale container, Funnel and the auth proxy are live; the GitHub sign-in lets Eric in (test 7); claude.ai gets real data, gated writes return a preview only, and a redeploy keeps the Skylight sign-in (tests 8 to 11); OpenCode signs in through `/mcps`.
- **Not yet run:** test 6 in full (Funnel answering `/mcp` with 401 was seen on 2026-11-21), test 12, a real Skylight verification code, and the client-token tests 13 to 17.
- **If claude.ai can't finish the OAuth flow:** use `tailscale serve` (tailnet only) instead of Funnel, or put a different OAuth proxy in front. Never ship a public endpoint protected only by a secret path.
