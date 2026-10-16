#!/usr/bin/env node
/** Bin entry: check the Node version BEFORE loading any dependency (static imports would fail first with an obscure error). */
import { nodeTooOld, nodeVersionMessage } from "./nodeVersion.js";
if (nodeTooOld(process.versions.node)) {
  process.stderr.write(nodeVersionMessage(process.version) + "\n");
  process.stdout.write(JSON.stringify({ error: nodeVersionMessage(process.version), code: "NODE_TOO_OLD" }) + "\n");
  process.exit(1);
}
await import("./main.js");
