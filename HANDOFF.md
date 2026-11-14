# Handoff: skylight-mcp-nas

You are picking up a project another agent session scaffolded. The user (Eric) will ask you questions about that session's work and decisions, then likely continue the project. Read this first, then read `README.md` and the files listed below before answering.

## Goal (from Eric's spec, Nov 12, 2026)

Run `skylight-mcp@1.6.2` in Docker on a Synology NAS, behind an OAuth sign-in proxy and a Tailscale Funnel sidecar, so it can be added as a claude.ai custom connector at `https://skylight.<tailnet>.ts.net/mcp`.

Done means: claude.ai lists the Skylight tools after GitHub sign-in; a read-only call returns real family data; an unauthenticated request gets a 401; no credential is in the repo, image or compose file.

Request path: claude.ai → Tailscale sidecar (TLS, Funnel 443) → `127.0.0.1:8000` mcp-auth-proxy (GitHub sign-in, limited to Eric's account) → `127.0.0.1:8001` supergateway → skylight-mcp over stdio. All containers share the `ts` container's network namespace; no host ports.

## Hard constraints (from the spec; keep following them)

- Work only in this repo (`~/Sites/skylight-mcp-nas`). Do not SSH to the NAS, sign in to Tailscale, GitHub or Skylight, or push anywhere unless Eric asks.
- Never write a real credential into any file, commit, log line or test fixture. Use `REPLACE_ME`.
- Everything pinned; no `latest`; no `npx -y` at container start; `npm ci` from the committed lockfile.
- Skylight container: non-root `node` user, read-only root fs, only `/data` writable.
- Never ship a secret-path-only public endpoint. Keep `MCP_CONFIRM_MODE=ask-user` (never `auto`) and `MCP_CONFIRM_ELICITATION=off`.
- Do not touch Eric's OpenCode config; only document changes in the README.
- Eric runs the NAS and claude.ai steps himself.

## State of the repo

Nothing is committed (`git init` done, all files untracked). Nothing is pushed. Docker Desktop was running on the laptop.

| File | Purpose |
| --- | --- |
| `Dockerfile` | `node:22.23.5-slim@sha256:e9f565d3…`, `npm ci --omit=dev`, non-root, `/data` volume |
| `package.json`, `package-lock.json` | `skylight-mcp` 1.6.2, `supergateway` 4.2.2 |
| `entrypoint.sh` | reads `/run/secrets/*` into env, refuses empty secrets, execs supergateway `--stateful` |
| `compose.yaml` | `ts` (tailscale v1.104.4), `auth` (mcp-auth-proxy v2.10.2), `skylight` (this image) |
| `compose.local.yaml` | local override: disables `ts` and `auth`, publishes `127.0.0.1:8001` |
| `ts-config/serve.json` | Funnel 443 → `127.0.0.1:8000` |
| `secrets.example/` | empty secret placeholders, `proxy.env`, `ts.env` with `REPLACE_ME` |
| `scripts/smoke-test.sh` | acceptance tests 1 to 3 |
| `README.md` | NAS setup, verified findings, OpenCode notes, rotation and rollback |

Verified: `./scripts/smoke-test.sh` passes tests 1 to 3 (116 tools listed with dummy credentials; no credential in image or repo; empty secret exits 1 before supergateway starts). `docker compose config` validates. The auth proxy was also run standalone against the local skylight container.

Not verified: acceptance tests 4 to 10 (need the NAS, Tailscale Funnel and claude.ai). The Tailscale container was never started. Skylight's real login, the confirm flow and the token cache were never exercised against the real API.

## Findings and deviations from the spec

1. **No single shared skylight-mcp process.** From supergateway 4.2.2 source (`dist/gateways/stdioToStatelessStreamableHttp.js`, `statefulSessions.js`): stateless spawns a child per request; stateful spawns one child per client session. The entrypoint uses `--stateful` with `--sessionTimeout` defaulting to 1800000 ms (`SESSION_TIMEOUT_MS`). Consequences: the emailed login code must be submitted in the same session as the login, and a pending login is lost if the session idles past the timeout. Confirm tokens verify across children because `MCP_CONFIRM_SECRET` is shared. This was read from source, not tested at runtime. Untested: concurrent children (for example claude.ai plus OpenCode) racing on `/data/.skylight-mcp/tokens.json` and on Skylight's rate-limited login.
   - The earlier agent first said a long-lived server "isn't possible", then corrected itself: the server is long-lived; only a single shared skylight-mcp child is unavailable through supergateway. It did not check whether mcp-auth-proxy's own stdio mode (`-- <command>`) shares one process, or whether a custom bridge could.
2. **mcp-auth-proxy v2.10.2 sends no `WWW-Authenticate` header on 401** (bare `{"error":"Unauthorized"}`; source: `pkg/proxy/proxy.go`). It does serve `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, and supports DCR at `POST /.idp/register` (returned 201 for a claude.ai redirect URI). Acceptance test 4 was rewritten to check 401 plus the 200 metadata URL. Whether claude.ai discovers the OAuth flow without the header is unproven until test 10.
3. GitHub callback path is `{EXTERNAL_URL}/.auth/github/callback`. HTTP backend syntax `command: ["--", "http://127.0.0.1:8001/mcp"]` works. The proxy image runs as root; its entrypoint is `/usr/local/bin/mcp-auth-proxy`.
4. Tailscale pinned to `v1.104.4`: v1.104.5 and v1.104.6 exist as GitHub releases but weren't on Docker Hub.
5. The lockfile must be generated with the image's npm. A lockfile from the laptop's npm (10.9.x via nvm) failed `npm ci` in the image, and `--package-lock-only` alone produced an incomplete tree. The README has the recipe (install, remove `node_modules`, `--package-lock-only`, then `npm ci`).
6. Small layout changes: `EXTERNAL_URL` and `GITHUB_ALLOWED_USERS` live in `proxy.env` (not `compose.yaml`); secret paths use `${SECRETS_DIR:-/volume1/docker/secrets/skylight}`; supergateway binds `127.0.0.1` by default (`GATEWAY_HOST=0.0.0.0` only in the local override).
7. The 2026-07-28 stateless MCP revision: supergateway's README says it supports it with fallback; only local Inspector testing was done, not claude.ai.

## Open items

- Eric has not decided: make an initial commit (and add a remote)? Add a `scripts/nas-setup.sh` wizard for the NAS-side secret and permission setup (step 1 of the README)? The earlier agent leaned toward skipping a wizard for the clicking steps in GitHub, Tailscale and claude.ai.
- Eric has not answered: does the Skylight account have more than one frame (if so add `SKYLIGHT_FRAME_ID`)? Pro/Max or Team claude.ai plan? Which write tools to block in the connector (suggested: `skylight_remove_user`, `skylight_delete_category`, `skylight_link_apple_calendar`)?
- Eric has questions about the earlier session's work; answer them before changing anything.
- Possible follow-ups, none started: runtime test of multi-session behavior; check whether a single shared child is achievable; `npm audit` reported advisories on install (not reviewed); the smoke test uses the deprecated `@modelcontextprotocol/inspector` v1 via `npx -y`.

## Notes

- Eric's global rule in his other repo (`ericmasiello-skills`) says never write to `main` there; that repo is separate and unrelated to this one.
- Delete or keep this file as Eric prefers; it is intentionally not referenced from the README.
