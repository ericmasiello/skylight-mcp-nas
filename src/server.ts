// The gateway (ADR 0001): one long-lived process serving the Skylight server
// over Streamable HTTP. It binds loopback by default and does no Origin checks.
// Every /mcp request must carry a client token (ADR 0003): the auth proxy sends
// its own for claude.ai and OpenCode, and tailnet clients such as ixl-nas send
// theirs, so a tailnet device can't reach the tools around the GitHub sign-in.
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadClientTokens, type ClientTokens } from './client-tokens.ts';
import { skylightServerFactory } from './skylight.ts';

const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
const port = Number(process.env.GATEWAY_PORT ?? 8001);

// Read straight from the secret files, not through the entrypoint, so tokens
// never enter the environment.
let tokens: ClientTokens;
try {
  tokens = loadClientTokens(process.env.GATEWAY_SECRETS_DIR ?? '/run/secrets');
} catch (error) {
  console.error(`gateway: ${(error as Error).message}`);
  process.exit(1);
}
console.error(`gateway: client tokens for ${tokens.clients.join(', ')}`);

const factory = skylightServerFactory();
// Build one server up front so a broken block list or registrar fails at boot,
// not on the first request.
await factory();

const handler = createMcpHandler(factory, {
  onerror: (error) => console.error(`gateway: ${error.message}`),
});
const mcp = toNodeHandler(handler);

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://gateway').pathname;
  if (path === '/mcp') {
    const result = tokens.check(req.headers.authorization);
    if (!result.ok) {
      // In userspace mode every tailnet request comes from 127.0.0.1, so the
      // peer address says nothing; the token itself is never logged.
      console.error(`gateway: refused /mcp (${result.reason})`);
      res
        .writeHead(401, {
          'content-type': 'text/plain',
          'www-authenticate': 'Bearer realm="skylight-gateway"',
        })
        .end('unauthorized\n');
      return;
    }
    void mcp(req, res);
  } else if (path === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
  }
});

server.listen(port, host, () => {
  console.error(`gateway: listening on http://${host}:${port}/mcp`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    void handler.close().finally(() => process.exit(0));
  });
}
