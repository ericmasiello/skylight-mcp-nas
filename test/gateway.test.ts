// End-to-end checks of the gateway against a fake Skylight. Nothing here talks
// to the real Skylight: SKYLIGHT_BASE_URL points at a local server that counts
// login attempts and fails them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BLOCKED_TOOLS } from '../src/blocked-tools.ts';

const GATEWAY_PORT = 18_701;
const url = new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`);

let fakeSkylight: Server;
let gateway: ChildProcess;
let loginAttempts = 0;

before(async () => {
  fakeSkylight = createServer((req, res) => {
    if (req.url?.startsWith('/auth/session/new')) loginAttempts += 1;
    // Slow enough that concurrent tool calls overlap one in-flight login.
    setTimeout(() => res.writeHead(503).end(), 500);
  });
  await new Promise<void>((resolve) => fakeSkylight.listen(0, '127.0.0.1', resolve));
  const { port } = fakeSkylight.address() as AddressInfo;

  gateway = spawn(process.execPath, ['src/server.ts'], {
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(GATEWAY_PORT),
      SKYLIGHT_BASE_URL: `http://127.0.0.1:${port}/api`,
      SKYLIGHT_EMAIL: 'test@example.com',
      SKYLIGHT_PASSWORD: 'not-a-real-password',
      MCP_CONFIRM_SECRET: 'test-confirm-secret-not-real-0000',
      MCP_CONFIRM_MODE: 'ask-user',
      MCP_CONFIRM_ELICITATION: 'off',
      MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'gateway-test-')),
    },
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    gateway.stderr?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('gateway: listening')) resolve();
    });
    gateway.once('exit', (code) => reject(new Error(`gateway exited with ${code}`)));
  });
});

after(() => {
  gateway.kill();
  fakeSkylight.close();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'gateway-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

test('lists tools without any blocked tool', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('skylight_list_frames'));
  for (const blocked of BLOCKED_TOOLS) assert.ok(!names.includes(blocked), `${blocked} is exposed`);
});

test('refuses to call a blocked tool', async () => {
  const client = await connect();
  const result = await client
    .callTool({ name: 'skylight_remove_user', arguments: {} })
    .then((r) => r.isError === true, () => true);
  await client.close();
  assert.ok(result, 'blocked tool call did not fail');
});

test('separate clients share one Skylight sign-in', async () => {
  loginAttempts = 0;
  const clients = await Promise.all(Array.from({ length: 5 }, connect));
  await Promise.all(
    clients.map((client) => client.callTool({ name: 'skylight_list_frames', arguments: {} }).catch(() => undefined)),
  );
  await Promise.all(clients.map((client) => client.close()));
  // One process, one sign-in manager: concurrent first calls share a single
  // in-flight login. A process per session would make five.
  assert.equal(loginAttempts, 1);
});
