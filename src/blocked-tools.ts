import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Admin write tools no client may see or call (ADR 0002). Unblocking one means
 * editing this list and redeploying.
 */
export const BLOCKED_TOOLS: readonly string[] = [
  // People
  'skylight_invite_user',
  'skylight_approve_user',
  'skylight_remove_user',
  'skylight_delete_category',
  // External calendars
  'skylight_link_apple_calendar',
  'skylight_add_webcal',
  'skylight_create_source_calendar',
  'skylight_delete_source_calendar',
  // Account settings
  'skylight_update_household_config',
  'skylight_update_profile',
];

/**
 * Wraps `server.registerTool` so every tool in `blocked` is removed the moment
 * it is registered. Must run before the tool registrars. Returns a check to
 * call after them: it throws when a blocked name was never registered, which
 * means skylight-mcp renamed or dropped it and the list needs updating. Failing
 * there keeps a rename from silently re-exposing the tool under its new name
 * unnoticed.
 */
export function blockTools(server: McpServer, blocked: readonly string[]): () => void {
  const pending = new Set(blocked);
  const register = server.registerTool.bind(server) as (...args: unknown[]) => { remove(): void };
  (server as { registerTool: unknown }).registerTool = (name: string, ...rest: unknown[]) => {
    const tool = register(name, ...rest);
    if (pending.delete(name)) tool.remove();
    return tool;
  };
  return () => {
    if (pending.size > 0) {
      throw new Error(`blocked tools were never registered: ${[...pending].join(', ')}`);
    }
  };
}
