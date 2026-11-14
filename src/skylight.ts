// Mirrors skylight-mcp's own entry point (node_modules/skylight-mcp/dist/index.js)
// but hands the server to an HTTP handler instead of stdio. The tool registrars
// and makeGetClient are not part of skylight-mcp's public exports, so they are
// imported by file path; check this list against dist/index.js on every
// skylight-mcp upgrade (ADR 0001).
import { createMcpServer } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import skylightPackage from 'skylight-mcp/package.json' with { type: 'json' };
import { makeGetClient } from '../node_modules/skylight-mcp/dist/get-client.js';
import { registerFrameTools } from '../node_modules/skylight-mcp/dist/tools/frames.js';
import { registerSettingsTools } from '../node_modules/skylight-mcp/dist/tools/settings.js';
import { registerCalendarTools } from '../node_modules/skylight-mcp/dist/tools/calendars.js';
import { registerMemberTools } from '../node_modules/skylight-mcp/dist/tools/members.js';
import { registerEventTools } from '../node_modules/skylight-mcp/dist/tools/events.js';
import { registerListTools } from '../node_modules/skylight-mcp/dist/tools/lists.js';
import { registerChoreTools } from '../node_modules/skylight-mcp/dist/tools/chores.js';
import { registerMealTools } from '../node_modules/skylight-mcp/dist/tools/meals.js';
import { registerMessageTools } from '../node_modules/skylight-mcp/dist/tools/messages.js';
import { registerTaskTools } from '../node_modules/skylight-mcp/dist/tools/tasks.js';
import { registerRewardTools } from '../node_modules/skylight-mcp/dist/tools/rewards.js';
import { registerAiTools } from '../node_modules/skylight-mcp/dist/tools/ai.js';
import { registerPhotoTools } from '../node_modules/skylight-mcp/dist/tools/photos.js';
import { registerHealthcheckTools } from '../node_modules/skylight-mcp/dist/tools/health.js';
import { registerLoginTools } from '../node_modules/skylight-mcp/dist/tools/login.js';
import { BLOCKED_TOOLS, blockTools } from './blocked-tools.ts';

type GetClient = ReturnType<typeof makeGetClient>;

/**
 * Returns the per-request server factory. Every server it builds shares one
 * `getClient`, so all MCP sessions share one Skylight sign-in and one pending
 * verification code.
 */
export function skylightServerFactory(
  getClient: GetClient = makeGetClient(),
  blocked: readonly string[] = BLOCKED_TOOLS,
): () => Promise<McpServer> {
  return async () => {
    let checkBlocked = () => {};
    const server = await createMcpServer({
      name: 'skylight-mcp',
      version: skylightPackage.version,
      deps: getClient,
      tools: [
        (s) => {
          checkBlocked = blockTools(s, blocked);
        },
        registerFrameTools,
        registerSettingsTools,
        registerCalendarTools,
        registerMemberTools,
        registerEventTools,
        registerListTools,
        registerChoreTools,
        registerMealTools,
        registerMessageTools,
        registerTaskTools,
        registerRewardTools,
        registerAiTools,
        registerPhotoTools,
        registerHealthcheckTools,
        registerLoginTools,
      ],
    });
    checkBlocked();
    return server;
  };
}
