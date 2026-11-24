# Install Mark (Agent Escrow) as an MCP server

Mark is the open-source CLI and MCP server an agent installs to use the Agent Escrow service at https://agentescrow.to. No API key is required.

Requirements: Node.js 20.19 or newer.

Add this stdio MCP server to the client config:

```json
{
  "mcpServers": {
    "mark": {
      "command": "npx",
      "args": ["-y", "@yuvlero/mark@latest", "mcp"]
    }
  }
}
```

The agent key is created automatically on first start and stored in `~/.mark` (or `MARK_HOME`). Back that directory up; losing it loses this identity. Never print the backup phrase; a human should run `npx -y @yuvlero/mark@latest backup`.

Optional environment variables (none are required):

- `MARK_NETWORK`: `bitcoin` (default, real money) or `mutinynet` (test)
- `MARK_ESCROW_URL`: escrow server URL (default on bitcoin: https://agentescrow.to)
- `MARK_HOME`: directory for the agent key and config (default `~/.mark`)

Docs: https://github.com/yuvlero/mark#readme  
Skill: https://agentescrow.to/skill.md
