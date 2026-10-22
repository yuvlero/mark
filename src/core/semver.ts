/** Tiny semver (2.0.0) parse + compare for client version checks. Byte-identical in escrow-server (src/lib/semver.ts) and Mark (src/core/semver.ts); parity test in the server repo.
 *  Accepts MAJOR.MINOR.PATCH with an optional -prerelease and +build (ignored), and an optional leading "v". No ranges. */
export interface SemVer { major: number; minor: number; patch: number; pre: string[] }
const RE = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parsed version, or null if `v` is not a plain semver string (at most 64 chars). */
export function parseSemver(v: unknown): SemVer | null {
  if (typeof v !== "string" || v.length > 64) return null;
  const m = RE.exec(v.trim()); if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}
/** Canonical form (no "v", no build metadata), or null when invalid. */
export function normalizeSemver(v: unknown): string | null {
  const s = parseSemver(v); return s ? `${s.major}.${s.minor}.${s.patch}${s.pre.length ? "-" + s.pre.join(".") : ""}` : null;
}
/** -1 / 0 / 1 like a sort comparator, semver precedence (1.0.0-rc.1 < 1.0.0; build metadata ignored). Throws on invalid input. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semver version: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1; if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
/** a < b (both valid semver). */
export const semverLt = (a: string, b: string) => compareSemver(a, b) < 0;
