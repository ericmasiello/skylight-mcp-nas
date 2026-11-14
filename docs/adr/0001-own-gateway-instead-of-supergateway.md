# Own gateway instead of supergateway

The gateway is our own TypeScript server, not supergateway. supergateway runs a separate skylight-mcp child process per MCP session, so each session has its own Skylight sign-in: a verification code can only be submitted in the session that triggered it, and clients like claude.ai and OpenCode would each sign in separately against Skylight's rate-limited login. Our server builds the tools in one long-lived process and serves them over HTTP with the MCP SDK's `createMcpHandler`. Every MCP session shares one Skylight sign-in, one token cache and one pending verification code.

## Consequences

- The server depends on skylight-mcp's internals (its tool registrars and `makeGetClient`), not on a public API. skylight-mcp stays a pinned npm dependency, not a fork, so each skylight-mcp upgrade has to be checked against those internals.
- `createMcpHandler` builds a fresh MCP server per HTTP request. Only the Skylight client is shared, so anything else skylight-mcp keeps per server instance does not survive between requests.
