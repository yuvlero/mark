/** "Is this Mark out of date?" The escrow server publishes its Mark version policy in GET /limits (`client`: minMarkVersion,
 *  latestMarkVersion, upgrade instructions). Mark caches it per escrow URL in <dataDir>/version-policy.json for 6 h, refreshing it
 *  whenever a command fetches /limits anyway, and otherwise fetching /limits at most once per 6 h. Below latest: a soft notice
 *  (CLI: one stderr line; MCP: an `updateNotice` field). Below min the server refuses with UPGRADE_REQUIRED (api/escrowApi.ts).
 *  Never auto-updates, never throws. */
import fs from "node:fs"; import path from "node:path";
import { MARK_VERSION } from "../version.js";
import { parseSemver, semverLt } from "./semver.js";
import { UPGRADE_HINT, type ClientPolicy, type Limits } from "../api/escrowApi.js";
import type { Ctx } from "./context.js";

export const VERSION_POLICY_TTL_MS = 6 * 3600_000;
type Entry = { fetchedAt: string; minMarkVersion: string | null; latestMarkVersion: string | null; upgrade?: ClientPolicy["upgrade"] };
const file = (c: Pick<Ctx, "dir">) => path.join(c.dir, "version-policy.json");
function readAll(c: Pick<Ctx, "dir">): Record<string, Entry> { try { const j = JSON.parse(fs.readFileSync(file(c), "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; } }
const ver = (v: unknown) => (typeof v === "string" && parseSemver(v) ? v : null);
const str = (v: unknown, max = 500) => (typeof v === "string" && v.length <= max ? v : undefined);

/** Store the policy from a /limits response (null / no `client` = this server publishes none). Never throws. */
export function rememberPolicy(c: Pick<Ctx, "dir" | "cfg">, l: Pick<Limits, "client"> | null | undefined, now = Date.now()) {
  const url = c.cfg.escrowUrl; if (!url) return;
  try {
    const p: any = l?.client && typeof l.client === "object" ? l.client : {};
    const up = p.upgrade && typeof p.upgrade === "object" ? { command: str(p.upgrade.command), global: str(p.upgrade.global), mcp: str(p.upgrade.mcp) } : undefined;
    const all = readAll(c); all[url] = { fetchedAt: new Date(now).toISOString(), minMarkVersion: ver(p.minMarkVersion), latestMarkVersion: ver(p.latestMarkVersion), ...(up ? { upgrade: up } : {}) };
    fs.writeFileSync(file(c), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  } catch { /* a cache only */ }
}
/** The cached policy for this escrow URL if younger than the TTL. */
export function cachedPolicy(c: Pick<Ctx, "dir" | "cfg">, now = Date.now()): Entry | null {
  const url = c.cfg.escrowUrl; if (!url) return null;
  const e = readAll(c)[url]; const t = e ? Date.parse(e.fetchedAt) : NaN;
  return e && Number.isFinite(t) && now - t < VERSION_POLICY_TTL_MS && t <= now + 60_000 ? e : null;
}

/** The notice text for `version` under policy `p`, or null when this Mark is current (or the server has no policy). */
export function noticeFor(p: Pick<Entry, "minMarkVersion" | "latestMarkVersion" | "upgrade"> | null, escrowUrl: string, version = MARK_VERSION): string | null {
  if (!p || !parseSemver(version)) return null;
  const up = { ...UPGRADE_HINT, ...Object.fromEntries(Object.entries(p.upgrade ?? {}).filter(([, v]) => typeof v === "string")) };
  const how = `Update: ${up.command} (global install: ${up.global}). ${up.mcp} Mark never updates itself.`;
  if (p.minMarkVersion && semverLt(version, p.minMarkVersion)) return `Mark ${version} is below the minimum ${p.minMarkVersion} of the escrow server ${escrowUrl}: it refuses this version (UPGRADE_REQUIRED). ${how}`;
  if (p.latestMarkVersion && semverLt(version, p.latestMarkVersion)) return `Mark ${p.latestMarkVersion} is available (this is ${version}); the escrow server ${escrowUrl} recommends updating before older versions stop working. ${how}`;
  return null;
}

/** Last refresh attempt per context: a long-lived MCP server retries a failed refresh at most every 15 minutes. */
const tried = new WeakMap<object, number>();
export const RETRY_MS = 15 * 60_000;
/** The update notice for this context: from the cache, else (fetch !== false) one GET /limits (5 s timeout). Never throws. */
export async function updateNotice(c: Ctx, o: { fetch?: boolean; now?: number } = {}): Promise<string | null> {
  try {
    const url = c.cfg.escrowUrl; if (!url) return null;
    const now = o.now ?? Date.now();
    let p = cachedPolicy(c, now);
    if (!p && o.fetch !== false && now - (tried.get(c) ?? -Infinity) >= RETRY_MS) {
      tried.set(c, now);
      try { rememberPolicy(c, await c.api.limits(undefined, 5_000), now); } catch (e: any) { if (e?.code === "NOT_FOUND") rememberPolicy(c, null, now); }
      p = cachedPolicy(c, now);
    }
    return noticeFor(p, url);
  } catch { return null; }
}
