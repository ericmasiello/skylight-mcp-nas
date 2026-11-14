# Block admin write tools in the server, not only in the connector

The Skylight server drops a pinned list of write tools after registering them, so no client can see or call them: inviting, approving and removing people, deleting a category, linking or adding external calendars, and changing household or profile settings. Switching tools off in the claude.ai connector only affects claude.ai. OpenCode and any other client reaching the same URL would still get all 116 tools, and a connector switch can be turned back on by accident. The connector switches stay available for tools that are allowed but that Eric doesn't want claude.ai to use.

## Consequences

- Unblocking a tool means changing the list in the repo and redeploying, not toggling it in claude.ai.
- The gateway refuses to start if a listed tool was never registered, so a skylight-mcp upgrade that renames a blocked tool fails loudly. A newly added admin tool is not caught; each upgrade has to be reviewed for one.
