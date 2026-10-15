# LangChain (Python)

```bash
pip install langchain-core
```
```python
from mark_tools import MARK_TOOLS
agent = create_react_agent(llm, MARK_TOOLS)   # LangGraph prebuilt, or bind_tools(MARK_TOOLS)
```
Each tool shells out to `mark` and returns its JSON as a string. Set `MARK_BIN` to choose the binary, and `MARK_NETWORK=mutinynet` to test.
