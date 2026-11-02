/** How the user started Mark, so printed commands can be copied as they are: `npx -y @yuvlero/mark ...` when Mark runs through npx
 *  and no `mark` is on PATH, else `mark ...`. Reads only the process's own argv/env and checks PATH entries for a `mark` file; no I/O
 *  beyond that, never throws. */
import fs from "node:fs";
import path from "node:path";

export const NPX_CMD = "npx -y @yuvlero/mark";
const NPX_DIR = /[\\/]_npx[\\/]/;
/** Started through npx / `npm exec`: the bin lives in npm's _npx cache, or npm says the command is exec. */
export function startedViaNpx(env: NodeJS.ProcessEnv = process.env, argv1: string = process.argv[1] ?? ""): boolean {
  return NPX_DIR.test(argv1) || env.npm_command === "exec" || /[\\/]npx-cli\.js$/.test(env.npm_execpath ?? "");
}
/** A `mark` executable on PATH, ignoring the temporary bin dirs npx puts in front (they vanish after the run). */
export function markOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const d of (env.PATH ?? "").split(path.delimiter)) {
    if (!d || NPX_DIR.test(d + path.sep)) continue;
    try { fs.accessSync(path.join(d, "mark"), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}
/** The command prefix to print: `npx -y @yuvlero/mark` or `mark`. */
export function commandPrefix(env: NodeJS.ProcessEnv = process.env, argv1: string = process.argv[1] ?? ""): string {
  try { return startedViaNpx(env, argv1) && !markOnPath(env) ? NPX_CMD : "mark"; } catch { return "mark"; }
}
let cached: string | undefined;
/** commandPrefix() for this process, computed once. */
export const mk = () => (cached ??= commandPrefix());

/** First real deal hint. DEMO_SATS is the escrow server's default house-seller offer (the built-in `summary` offer, 350 sats); the
 *  live price comes from GET /demo and `mark demo` always shows it before anything is created. */
export const DEMO_SATS = 350;
export const WALLET_DOCS = "https://second.tech/docs/getting-started/bark-cli";
/** Wallet balance to suggest for a deal of `sats`: the amount plus room for the Lightning swap fee, rounded up to 100 (350 -> 400). */
export const walletSats = (sats: number) => Math.ceil((sats + 50) / 100) * 100;
export const walletLine = (sats = DEMO_SATS) => `To pay you need a Lightning wallet with about ${walletSats(sats)} sats, e.g. Bark: ${WALLET_DOCS}`;
/** The top-level `next` sentence of `mark` (no args), `mark init` and `mark pubkey`. */
export const firstDealNext = (prefix: string = mk()) =>
  `Next: try one real deal (${DEMO_SATS} sats, about 10 min, preview first, nothing is created): ${prefix} demo --url https://example.com. ${walletLine()}`;
