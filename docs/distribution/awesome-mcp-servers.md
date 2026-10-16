# Draft PRs for awesome-mcp-servers lists

Both need Yuri: fork the repo as `yuvlero`, commit, and open the PR. Nothing has been opened.

## punkpeye/awesome-mcp-servers
- Category: **🤝 Agreements & Coordination**. Its blurb is "commitments, escrow, and multi-party decision workflows across humans, agents, and organizations". Keep entries alphabetical by `owner/repo`.
- Legend: 📇 = TypeScript, ☁️ = talks to a remote API (the escrow server), 🍎 🐧 = tested on macOS/Linux. Add 🪟 only after a Windows test.
- The list asks for a Glama score badge, so get the Glama listing first (glama.md).

Line to add:
```markdown
- [yuvlero/mark](https://github.com/yuvlero/mark) [![yuvlero/mark MCP server](https://glama.ai/mcp/servers/yuvlero/mark/badges/score.svg)](https://glama.ai/mcp/servers/yuvlero/mark) 📇 ☁️ 🍎 🐧 - Non-custodial 2-of-3 Bitcoin escrow for agent-to-agent deals on Arkade, Lightning in/out: signed terms, funding, evidence, release/refund, disputes and signed messages.
```
PR title: `Add yuvlero/mark (agent-to-agent Bitcoin/Lightning escrow)`

PR body:
```
Adds Mark, an MCP stdio server (and CLI) for non-custodial 2-of-3 escrow between AI agents.
- Category: Agreements & Coordination (escrow)
- TypeScript, MIT, runs locally via `npx -y @yuvlero/mark mcp`; talks to an escrow server (default https://agentescrow.to)
- Tools: escrow_create / accept / fund / evidence / approve / refund / dispute / invites / messages and more
- Proof: a real agent-to-agent mainnet deal completed in about 9 minutes (5000 sats, 330 sats fee, 4634 sats delivered over Lightning)
```

## appcypher/awesome-mcp-servers
- Category: **💹 Finance**. The format is a favicon `<img>`, then `[Name](url)`, then ` - description`. Read the repo's CONTRIBUTING.md before opening the PR.

Line to add:
```markdown
- <img src="https://bitcoin.org/favicon.png" height="14"/> [Mark (agent escrow)](https://github.com/yuvlero/mark) - Non-custodial 2-of-3 Bitcoin escrow for agent-to-agent deals on Arkade with Lightning in/out: signed terms, funding, release/refund, disputes and signed messages
```
PR title: `Add Mark: agent-to-agent Bitcoin/Lightning escrow MCP server`
PR body: the same as above.
