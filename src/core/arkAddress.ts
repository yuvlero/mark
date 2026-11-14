/** Ark address checks for payouts and direct Ark funding. Shared with its counterpart in the other repo (Mark / escrow server),
 *  identical apart from the error class; a server-side parity test enforces it.
 *  An escrow runs on ONE Arkade server. An Ark address encodes the key of the Ark server it was made for, and only works there:
 *  Bark / Second Ark addresses (another Ark server) can neither receive an Arkade payout nor fund an Arkade escrow. */
import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { MarkError } from "../errors.js";

/** Address prefix (bech32m hrp) per network. */
export const ARK_HRP: Record<string, string> = { bitcoin: "ark", mutinynet: "tark" };

/** The one-paragraph explanation used in help, errors, /limits and docs. */
export function arkadeNote(arkServerUrl: string): string {
  return `This escrow runs on the Arkade server ${arkServerUrl}. Only Ark addresses from an Arkade wallet on that server work (payouts and direct Ark funding). Bark / Second Ark addresses, or addresses from any other Ark server, will NOT work: use Lightning instead (a BOLT11 invoice or a Lightning address).`;
}

export interface ArkadeTarget {
  /** escrow network: bitcoin (ark1...) or mutinynet (tark1...) */ network: string;
  /** the Arkade server key (x-only or compressed hex); null/undefined = prefix check only */ serverPubkey?: string | null;
  /** shown in every message */ arkServerUrl: string;
  /** what is being checked, e.g. "payout address" */ what?: string;
}

/** Server key (x-only hex) encoded in an Ark address, or null if it is not a decodable Ark address. */
export function arkAddressServerKey(addr: string): string | null {
  try { return hex.encode(ArkAddress.decode(addr.trim()).serverPubKey).slice(-64); } catch { return null; }
}

/** Fail early: the trimmed address if it is an Ark address for this network AND this Arkade server; else BAD_DEST with a message
 *  that names the server (details.reason: not_ark_address | wrong_network | wrong_ark_server). */
export function checkArkadeAddress(addr: unknown, t: ArkadeTarget): string {
  const what = t.what ?? "Ark address"; const a = typeof addr === "string" ? addr.trim() : "";
  const base = { arkServerUrl: t.arkServerUrl, arkServerPubkey: t.serverPubkey ? t.serverPubkey.toLowerCase().slice(-64) : null, network: t.network };
  let d: ArkAddress;
  try { d = ArkAddress.decode(a); } catch { throw new MarkError("BAD_DEST", `${what} is not a valid Ark address. ${arkadeNote(t.arkServerUrl)}`, { ...base, reason: "not_ark_address" }); }
  const want = ARK_HRP[t.network];
  if (want && d.hrp !== want) throw new MarkError("BAD_DEST", `${what} is a ${d.hrp}1... address, but this escrow is on ${t.network} and needs a ${want}1... address. ${arkadeNote(t.arkServerUrl)}`, { ...base, reason: "wrong_network", prefix: d.hrp, expectedPrefix: want });
  if (t.serverPubkey) {
    const got = hex.encode(d.serverPubKey).slice(-64);
    if (got !== base.arkServerPubkey) throw new MarkError("BAD_DEST", `${what} belongs to a different Ark server (server key ${got.slice(0, 16)}...), not to this escrow's Arkade server ${t.arkServerUrl} (key ${base.arkServerPubkey!.slice(0, 16)}...). ${arkadeNote(t.arkServerUrl)}`, { ...base, reason: "wrong_ark_server", addressServerPubkey: got });
  }
  return a;
}
