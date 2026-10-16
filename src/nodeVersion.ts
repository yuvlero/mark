/** Minimum Node.js for Mark. 20.19 is the floor: it is the first 20.x with require(esm) unflagged, which the
 *  @noble/@scure/@bitcoinerlab deps need (they declare >=20.19). The Arkade SDK declares >=22.12, but Mark only uses
 *  its ArkAddress codec (no WebSocket/EventSource), and the full test suite passes on Node 20.19. */
export const MIN_NODE = "20.19.0";
export function nodeTooOld(version: string, min = MIN_NODE): boolean {
  const p = (v: string) => v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [a, b] = [p(version), p(min)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}
export function nodeVersionMessage(version: string, min = MIN_NODE) { return `Mark needs Node ${min}+, you have ${version}. Install a newer Node (e.g. nvm install 22) and retry.`; }
