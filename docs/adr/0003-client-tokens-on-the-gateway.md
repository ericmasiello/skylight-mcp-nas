# Client tokens on the gateway

The gateway requires a client token, a bearer token for one client, on every `/mcp` request, and a tailnet policy lets only ixl-nas reach its port. Two problems led here. First, the gateway was open to the whole tailnet: with `TS_USERSPACE=true`, Tailscale forwards inbound tailnet TCP to `127.0.0.1:<port>`, so any of Eric's devices reached `skylight:8001/mcp` without the GitHub sign-in. Second, ixl-nas, a headless job on its own tailnet device, needs the Skylight server but can't do an interactive GitHub sign-in, and must not do its own Skylight sign-in.

Each client has its own token, a Docker secret `client_token_<client>`, so any one can be revoked without the others. The auth proxy is one of these clients: mcp-auth-proxy replaces the user's `Authorization` header with `Bearer <PROXY_BEARER_TOKEN>` before forwarding, so claude.ai and OpenCode work as before. The gateway keeps only SHA-256 digests, compares each request against all of them with `timingSafeEqual`, refuses to start with no token, an empty, short or duplicate one, and never logs a token. `/healthz` stays open, because `deploy.sh`, the image `HEALTHCHECK` and ixl-nas's "gateway down vs. Skylight refused" check all use it.

## Considered options

These were weighed in ixl-nas's [Choose the Skylight access route](https://github.com/ericmasiello/ixl-nas/issues/3):

- **Join the `ts` container's network namespace:** ixl-nas would reach `127.0.0.1:8001` directly, but only while both projects share a machine. It would also give ixl-nas no identity of its own.
- **An OAuth refresh token from the auth proxy:** ixl-nas would hold a long-lived GitHub-backed credential and depend on the auth proxy's token lifetime and storage.
- **A Unix socket in a shared volume:** works only on one machine, and adds a second listener to the gateway.
- **A shared Docker network:** also machine-bound, and the gateway would listen on a non-loopback address.

## Consequences

- Adding a client means a new `client_token_<name>` secret in `compose.yaml` and a stage entry in `scripts/nas-setup.sh`. Revoking one means deleting its file, removing it from `compose.yaml` and redeploying.
- The gateway and the auth proxy must deploy together: if the gateway checks tokens before the proxy sends one, every claude.ai call gets 401 while `/healthz` stays green. They share one compose project and one `docker compose up`, and `deploy.sh` stops before rebuilding if a token file is missing.
- Tagged devices are not in `autogroup:member`, so the policy's Funnel attribute targets `tag:skylight`.
