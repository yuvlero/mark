/** Package version, read from package.json at runtime (dist/src/version.js -> ../../package.json), so the MCP server never drifts from the release. */
import fs from "node:fs";
export const MARK_VERSION: string = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
