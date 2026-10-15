# Distribution checklist (drafts, nothing submitted)

Nothing here has been published or submitted. **Each step that needs an account needs Yuri's explicit approval in chat.**

| # | Step | Needs Yuri's account | Depends on |
|---|---|---|---|
| 1 | Push the repo (`git push origin main`) | GitHub (yuvlero) | — |
| 2 | `npm login`, then `npm publish` (scoped, `publishConfig.access: public`) | **npm** account owning the `@yuvlero` scope (user `yuvlero`, or an org of that name) with 2FA | 1 |
| 3 | Official MCP Registry: `mcp-publisher login github`, then `mcp-publisher publish` (reads `./server.json`) | **GitHub OAuth** (device flow) as `yuvlero`; it proves the `io.github.yuvlero/*` namespace | 2 (the registry checks `mcpName` in the published npm package) |
| 4 | Smithery: add the server from the GitHub repo (`smithery.yaml`) | **Smithery** login (GitHub OAuth) | 1, 2 |
| 5 | Glama: claim or submit the server (see glama.md) | **Glama** login (GitHub OAuth) | 1 |
| 6 | mcp.so: submit (see mcp-so.md) | **mcp.so** login (GitHub/Google) | 1 |
| 7 | awesome-mcp-servers PRs (punkpeye, appcypher) | **GitHub**: fork both repos and open PRs as yuvlero | 1, ideally 2 and 5 (the punkpeye list wants a Glama badge) |

## Open issue before listing
`mark mcp` needs a key: it exits with `NOT_INITIALIZED` until `mark init` has run. Registry inspectors (Glama, Smithery) start it fresh. Decide between auto-init on first `mcp` start (code change) and a documented init step. See glama.md.

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
mcp-publisher login github             # Yuri, device flow
mcp-publisher publish                  # validates server.json; mcpName in package.json must equal server.json name
```
- Version bumps: keep `package.json` `version`, `server.json` `version` and `server.json` `packages[0].version` identical. `test/distribution.test.mjs` checks this.
- After publishing, switch the server's front door (`/llms.txt`, `/.well-known/mcp.json`) from "once published" to the npm name.
