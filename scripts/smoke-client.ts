// Connects to a running gateway, lists every tool and checks that none of the
// blocked tools is exposed. Prints the tool count; exits 1 on any failure.
// The client token comes from the environment, never argv, so it stays out of
// ps; without GATEWAY_TOKEN it connects with no token (and should be refused).
//   GATEWAY_TOKEN=… node scripts/smoke-client.ts http://127.0.0.1:8001/mcp
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BLOCKED_TOOLS } from '../src/blocked-tools.ts';

const url = process.argv[2] ?? 'http://127.0.0.1:8001/mcp';
const token = process.env.GATEWAY_TOKEN;
const requestInit = token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } };
const client = new Client({ name: 'skylight-mcp-nas-smoke', version: '0.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
} catch (error) {
  console.error(`smoke client: could not connect: ${(error as Error).message}`);
  process.exit(1);
}

const names: string[] = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor === undefined ? {} : { cursor });
  names.push(...page.tools.map((tool) => tool.name));
  cursor = page.nextCursor;
} while (cursor !== undefined);
await client.close();

const exposed = BLOCKED_TOOLS.filter((name) => names.includes(name));
if (exposed.length > 0) {
  console.error(`blocked tools exposed: ${exposed.join(', ')}`);
  process.exit(1);
}
console.log(`${names.length} tools listed, ${BLOCKED_TOOLS.length} blocked tools absent`);
