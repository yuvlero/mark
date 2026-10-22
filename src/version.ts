/** Package version, read from package.json at runtime (dist/src/version.js -> ../../package.json), so the MCP server never drifts from the release. */
import fs from "node:fs";
export const MARK_VERSION: string = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
/** Sent on every escrow-server request (with the x-mark-version header) so the server can tell old clients to update. */
export const MARK_USER_AGENT = `mark/${MARK_VERSION}`;
