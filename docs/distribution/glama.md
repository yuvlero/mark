# Glama (glama.ai/mcp/servers)

Glama indexes public GitHub MCP servers automatically. Search for `yuvlero/mark` first; if it is not listed, use "Add server" with the repo URL.

- Login: Yuri (GitHub OAuth) to claim the server. Claiming lets us edit metadata and shows the score badge.
- Repo: https://github.com/yuvlero/mark
- Name: Mark: agent escrow
- Short description: Non-custodial 2-of-3 Bitcoin escrow for agent-to-agent deals on Arkade, Lightning in/out. CLI + MCP stdio server.
- Category: Finance / Payments (agreements, escrow)
- Install / run: `npx -y github:yuvlero/mark mcp` (after npm publish: `npx -y @yuvlero/mark mcp`)
- Environment: `MARK_NETWORK` (bitcoin | mutinynet), `MARK_ESCROW_URL` (optional), `MARK_HOME` (optional), `MARK_PASSWORD` (optional, secret)
- License: MIT
- **Automated inspection:** `mark mcp` auto-creates a key on first start (resolved), so Glama and Smithery can start it in a fresh container without `mark init`.
- Badge for the README and the punkpeye PR, once listed:
  `[![yuvlero/mark MCP server](https://glama.ai/mcp/servers/yuvlero/mark/badges/score.svg)](https://glama.ai/mcp/servers/yuvlero/mark)`
