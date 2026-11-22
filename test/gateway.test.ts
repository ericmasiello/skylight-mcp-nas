// End-to-end checks of the gateway against a fake Skylight. Nothing here talks
// to the real Skylight: SKYLIGHT_BASE_URL points at a local server that counts
// login attempts and fails them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BLOCKED_TOOLS } from '../src/blocked-tools.ts';

const GATEWAY_PORT = 18_701;
const url = new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`);
const TOKENS = {
  auth_proxy: 'test-token-auth-proxy-0000000000000000',
  ixl_nas: 'test-token-ixl-nas-00000000000000000000',
};

let fakeSkylight: Server;
let gateway: ChildProcess;
let loginAttempts = 0;
let skylightUrl = '';

function tokenDir(tokens: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-secrets-'));
  for (const [client, token] of Object.entries(tokens)) writeFileSync(join(dir, `client_token_${client}`), `${token}\n`);
  return dir;
}

function startGateway(port: number, secretsDir: string): ChildProcess {
  return spawn(process.execPath, ['src/server.ts'], {
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      GATEWAY_SECRETS_DIR: secretsDir,
      SKYLIGHT_BASE_URL: skylightUrl,
      SKYLIGHT_EMAIL: 'test@example.com',
      SKYLIGHT_PASSWORD: 'not-a-real-password',
      MCP_CONFIRM_SECRET: 'test-confirm-secret-not-real-0000',
      MCP_CONFIRM_MODE: 'ask-user',
      MCP_CONFIRM_ELICITATION: 'off',
      MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'gateway-test-')),
    },
    stdio: ['ignore', 'inherit', 'pipe'],
  });
}

before(async () => {
  fakeSkylight = createServer((req, res) => {
    if (req.url?.startsWith('/auth/session/new')) loginAttempts += 1;
    // Slow enough that concurrent tool calls overlap one in-flight login.
    setTimeout(() => res.writeHead(503).end(), 500);
  });
  await new Promise<void>((resolve) => fakeSkylight.listen(0, '127.0.0.1', resolve));
  const { port } = fakeSkylight.address() as AddressInfo;
  skylightUrl = `http://127.0.0.1:${port}/api`;

  gateway = startGateway(GATEWAY_PORT, tokenDir(TOKENS));
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

async function connect(token: string = TOKENS.ixl_nas): Promise<Client> {
  const client = new Client({ name: 'gateway-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
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
  const clients = await Promise.all(Array.from({ length: 5 }, () => connect()));
  await Promise.all(
    clients.map((client) => client.callTool({ name: 'skylight_list_frames', arguments: {} }).catch(() => undefined)),
  );
  await Promise.all(clients.map((client) => client.close()));
  // One process, one sign-in manager: concurrent first calls share a single
  // in-flight login. A process per session would make five.
  assert.equal(loginAttempts, 1);
});

test('keeps the tool contract ixl-nas depends on', async () => {
  // ixl-nas calls these two headlessly. A skylight-mcp bump that renames them,
  // drops their fields or adds a confirm gate must fail the image build.
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const properties = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is missing`);
    return Object.keys(tool.inputSchema.properties ?? {});
  };
  const chore = properties('skylight_create_chore');
  for (const field of ['summary', 'category_id', 'start']) assert.ok(chore.includes(field), `create_chore lacks ${field}`);
  assert.ok(!chore.includes('confirmToken'), 'skylight_create_chore gained a confirm gate');
  assert.ok(properties('skylight_resolve_member').includes('name'), 'resolve_member lacks name');
});

test('each client token can list tools', async () => {
  for (const token of Object.values(TOKENS)) {
    const client = await connect(token);
    const { tools } = await client.listTools();
    await client.close();
    assert.ok(tools.length > 0);
  }
});

test('refuses /mcp without a known client token', async () => {
  const cases: Record<string, string | undefined> = {
    'no header': undefined,
    'Basic scheme': `Basic ${Buffer.from(`x:${TOKENS.ixl_nas}`).toString('base64')}`,
    'unknown token': 'Bearer test-token-nobody-000000000000000000000',
    'known token plus a character': `Bearer ${TOKENS.ixl_nas}x`,
  };
  for (const [name, authorization] of Object.entries(cases)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401, name);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="skylight-gateway"', name);
    assert.equal(await res.text(), 'unauthorized\n', name);
  }
});

test('/healthz needs no token', async () => {
  const res = await fetch(new URL('/healthz', url));
  assert.equal(res.status, 200);
});

async function refusedStart(secretsDir: string): Promise<void> {
  const child = startGateway(GATEWAY_PORT + 1, secretsDir);
  let log = '';
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.ok(code !== 0 && code !== null, `exited with ${code}`);
  assert.match(log, /gateway: .*client token/);
  assert.doesNotMatch(log, /gateway: listening/);
}

test('refuses to start without client token files', async () => {
  await refusedStart(tokenDir({}));
});

test('refuses to start with a client token shorter than 32 characters', async () => {
  await refusedStart(tokenDir({ short: 'too-short-token' }));
});
