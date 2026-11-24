# Glama (glama.ai/mcp/servers)

Glama indexes public GitHub MCP servers automatically. Search for `yuvlero/mark` first; if it is not listed, use "Add server" with the repo URL.

- Login: Yuri (GitHub OAuth) to claim the server. Claiming lets us edit metadata and shows the score badge.
- Repo: https://github.com/yuvlero/mark
- Name: Mark: agent escrow
- Short description: Non-custodial 2-of-3 Bitcoin escrow for agent-to-agent deals on Arkade, Lightning in/out. CLI + MCP stdio server.
- Category: Finance / Payments (agreements, escrow)
- Install / run: `npx -y @yuvlero/mark@latest mcp` (latest from GitHub: `npx -y github:yuvlero/mark mcp`)
- Environment: `MARK_NETWORK` (bitcoin | mutinynet), `MARK_ESCROW_URL` (optional), `MARK_HOME` (optional), `MARK_PASSWORD` (optional, secret)
- License: MIT
- **Automated inspection:** `mark mcp` auto-creates a key on first start (resolved), so Glama and Smithery can start it in a fresh container without `mark init`.
- Badge for the README and the punkpeye PR, once listed:
  `[![yuvlero/mark MCP server](https://glama.ai/mcp/servers/yuvlero/mark/badges/score.svg)](https://glama.ai/mcp/servers/yuvlero/mark)`

## Quality score (needed for punkpeye/awesome-mcp-servers PR #16548)

The listing is already claimed. Quality stays "Not graded" until there is a deployable Glama release.

1. Push `Dockerfile` and `glama.json` (maintainers: `yuvlero`) to GitHub.
2. Sign in to Glama as yuvlero and open https://glama.ai/mcp/servers/yuvlero/mark/admin/dockerfile
3. Sync the server so the mirror is at the new commit (leave any pinned SHA empty).
4. If the form uses the repository Dockerfile, point it at the repo `Dockerfile`. If it asks for a generated build spec instead, use either:
   - From source: build steps `["npm ci --omit=optional --ignore-scripts", "npx tsc"]`, CMD arguments `["node", "dist/src/cli.js", "mcp"]`
   - From npm: build steps `["npm install -g @yuvlero/mark@latest"]`, CMD arguments `["mark", "mcp"]`
   Environment schema can stay `{"type":"object","properties":{},"required":[]}`; placeholder parameters `{}`. The server auto-creates a key in `MARK_HOME` on first start, so a fresh container needs no credentials to pass `initialize` + `tools/list`.
5. Click Deploy (build test). When it passes, Make Release / Create & Publish Release with the current Mark version. That is what assigns a quality grade (any grade unblocks PR #16548).
6. If `glama.json` was added after the first claim, run the claim-ownership flow once more so Glama picks up maintainers.
