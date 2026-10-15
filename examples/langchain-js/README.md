# LangChain.js

```bash
npm i @langchain/core zod
```
```js
import { markTools } from "./markTools.mjs";
const agent = createReactAgent({ llm, tools: markTools });   // any LangChain/LangGraph agent
```
Each tool returns Mark's JSON as a string. Add more tools the same way (`create`, `fund`, `pending`, `refund`, `dispute`); the commands are in the Mark README, section 7. Funding (`fund`) prints an invoice for a human or a wallet tool to pay. Keep that step behind explicit approval.
