# Distribution checklist (drafts, nothing submitted)

Nothing here has been published or submitted. **Each step that needs an account needs Yuri's explicit approval in chat.**

| # | Step | Needs Yuri's account | Depends on |
|---|---|---|---|
| 1 | Push the repo (`git push origin main`) | GitHub (yuvlero) | — |
| 2 | `npm login`, then `npm publish` (scoped, `publishConfig.access: public`) | **npm** account owning the `@yuvlero` scope (user `yuvlero`, or an org of that name) with 2FA | 1 |
| 3 | Official MCP Registry: `mcp-publisher login dns --domain agentescrow.to --private-key-file /home/box/ark/mcp-registry/key.hex`, then `mcp-publisher publish` (reads `./server.json`) | **DNS** key for `agentescrow.to` (TXT record); it proves the `to.agentescrow/*` namespace. Since 0.4.2 the name is `to.agentescrow/mark`; the old `io.github.yuvlero/mark` is deprecated (below) | 2 (the registry checks `mcpName` in the published npm package) |
| 4 | Smithery: add the server from the GitHub repo (`smithery.yaml`) | **Smithery** login (GitHub OAuth) | 1, 2 |
| 5 | Glama: claim or submit the server (see glama.md) | **Glama** login (GitHub OAuth) | 1 |
| 6 | mcp.so: submit (see mcp-so.md) | **mcp.so** login (GitHub/Google) | 1 |
| 7 | awesome-mcp-servers PRs (punkpeye, appcypher) | **GitHub**: fork both repos and open PRs as yuvlero | 1, ideally 2 and 5 (the punkpeye list wants a Glama badge) |

## Fresh-start inspection (resolved)
`mark mcp` auto-creates the agent key on first start (never overwriting an existing one), so registry inspectors (Glama, Smithery) can start it fresh.

## Release steps (when approved)
```bash
cd mark
npm ci && npm test
npm pack --dry-run                     # expect: dist/src, docs, README.md, LICENSE, npm-shrinkwrap.json, package.json
npm login                              # Yuri
npm publish                            # Yuri approves; publishConfig.access=public
npx -y @yuvlero/mark                   # smoke test from the registry
# MCP registry (https://github.com/modelcontextprotocol/registry, docs: modelcontextprotocol.io/registry)
brew install mcp-publisher             # or a release binary
mcp-publisher login dns --domain agentescrow.to --private-key-file /home/box/ark/mcp-registry/key.hex
mcp-publisher publish                  # validates server.json; mcpName in package.json must equal server.json name
# One-time (0.4.2): deprecate the old GitHub-namespace name. Needs a GitHub login as yuvlero:
mcp-publisher login github             # Yuri, device flow
mcp-publisher status --status deprecated --all-versions --message "Moved to to.agentescrow/mark" io.github.yuvlero/mark
```
- Version bumps: keep `package.json` `version`, `server.json` `version` and `server.json` `packages[0].version` identical. `test/distribution.test.mjs` checks this.
- Done (0.1.2 published): the server's front door (`/`, `/llms.txt`, `/.well-known/*`) uses `npx -y @yuvlero/mark`.
