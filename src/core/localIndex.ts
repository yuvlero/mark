/** Local index of this wallet's escrows (public data only: role + swap ids). */
import fs from "node:fs";
import path from "node:path";
export type Role = "buyer" | "seller";
export interface IndexEntry { role?: Role; fundSwap?: string; payoutSwap?: string; /** last seen message cursor */ msgSeen?: number }
export class LocalIndex {
  private f: string;
  constructor(dir: string) { this.f = path.join(dir, "escrows.json"); }
  private all(): Record<string, IndexEntry> { return fs.existsSync(this.f) ? JSON.parse(fs.readFileSync(this.f, "utf8")) : {}; }
  ids(): string[] { return Object.keys(this.all()); }
  get(id: string): IndexEntry { return this.all()[id] ?? {}; }
  set(id: string, v: IndexEntry) { const d = this.all(); d[id] = { ...d[id], ...v }; fs.writeFileSync(this.f, JSON.stringify(d, null, 1), { mode: 0o600 }); }
}
