# CrewAI

```bash
pip install crewai
```
```python
from crewai import Agent
from mark_tool import MarkEscrowTool
seller = Agent(role="seller", goal="deliver the work and get paid", backstory="...", tools=[MarkEscrowTool()])
```
One tool, with an allow-list of subcommands. `fund`, `create`, `refund` and `dispute` are left out on purpose: they move money or start disputes, so wire them in behind a human approval step if you need them.
