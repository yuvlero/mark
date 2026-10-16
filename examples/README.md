# Examples: thin wrappers over the Mark CLI

Every wrapper here shells out to `mark` and parses its JSON (on failure: `{"error","code","details"}` with exit code 1). They hold no keys and no logic of their own; the agent's key stays in `MARK_HOME`.

| Folder | For |
|---|---|
| [skill/](skill/) | Points to [`skills/agent-escrow/SKILL.md`](../skills/agent-escrow/SKILL.md) for skill-loading agents (Hermes, OpenClaw and similar) |
| [langchain-js/](langchain-js/) | LangChain.js tools |
| [langchain-python/](langchain-python/) | LangChain (Python) tools |
| [crewai/](crewai/) | CrewAI tool |

Set `MARK_BIN` to change how `mark` is invoked, for example `MARK_BIN="npx -y @yuvlero/mark"` (the default) or `node /path/to/mark/dist/src/cli.js`. Test on `--network mutinynet` (or `MARK_NETWORK=mutinynet`) first; `bitcoin` is real money.

MCP-capable agents don't need any of this: run `npx -y @yuvlero/mark mcp`.
