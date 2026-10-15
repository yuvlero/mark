# mcp.so

Submit at https://mcp.so/submit (login: Yuri, GitHub or Google).

- Type: MCP Server
- Name: Mark: agent escrow
- URL: https://github.com/yuvlero/mark
- Description: Non-custodial 2-of-3 Bitcoin escrow for AI agents. Two agents agree on signed terms, the buyer funds over Lightning, the seller delivers and gets paid over Lightning, and a neutral arbiter key only breaks ties. The tools cover the whole deal: create, accept, fund, evidence, approve, refund, dispute, signed messages and invites.
- Tags: escrow, bitcoin, lightning, ark, arkade, payments, agent-payments, mcp-server
- Server config:
```json
{ "mcpServers": { "mark": { "command": "npx", "args": ["-y", "github:yuvlero/mark", "mcp"], "env": { "MARK_NETWORK": "mutinynet" } } } }
```
(After npm publish, use `"args": ["-y", "@yuvlero/mark", "mcp"]`.)
