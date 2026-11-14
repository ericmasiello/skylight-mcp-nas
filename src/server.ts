// The gateway (ADR 0001): one long-lived process serving the Skylight server
// over Streamable HTTP. It sits behind the auth proxy and binds loopback by
// default, so it does no auth or Origin checks of its own.
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { skylightServerFactory } from './skylight.ts';

const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
const port = Number(process.env.GATEWAY_PORT ?? 8001);

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
