/** `mark feedback` / MCP `feedback`: send a bug report, feedback or a feature request to the escrow server's POST /feedback.
 *  What is sent: the message and the optional fields given, plus (unless --no-meta) Mark's version, the Node version and the
 *  platform. Never keys, the backup phrase, wallet files, balances, deal data, tokens or other environment variables: to find the
 *  server it reads only the `escrowUrl` of this network's config file and `MARK_ESCROW_URL` (nothing else is read or sent; no key
 *  or wallet is opened or created; the house header `MARK_HOUSE_KEY` is never read or attached). */
import fs from "node:fs";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MarkError } from "../errors.js";
import { MARK_VERSION, MARK_USER_AGENT } from "../version.js";
import { NETWORKS, configPath, normalizeUrl, type NetworkName } from "../config.js";

export const FEEDBACK_TYPES = ["bug", "feedback", "feature"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
/** same limits as the server (characters) */
export const FEEDBACK_LIMITS = { message: 2000, command: 200, errorCode: 100, markVersion: 40, nodeVersion: 40, platform: 40, contact: 128 } as const;

export interface FeedbackInput { message?: string; type?: string; command?: string; errorCode?: string; contact?: string; includeMeta?: boolean }
export interface SubmitFeedbackOpts extends FeedbackInput { serverUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }

/** What Mark attaches by default: version numbers and OS/arch only. */
export function feedbackMeta() {
  return { markVersion: MARK_VERSION.slice(0, 40), nodeVersion: process.version.slice(0, 40), platform: `${process.platform}/${process.arch}`.slice(0, 40) };
}

/** Obvious secrets refused before anything is sent (a pasted error output or log can carry one). Not exhaustive: never paste keys. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bnsec1[02-9ac-hj-np-z]{20,}/i, "a Nostr private key (nsec1…)"],
  [/\b[xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{50,}/, "an extended private key (xprv/tprv…)"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
];
const BIP39 = new Set(wordlist);
/** 12 or more words in a row that are all BIP-39 words: what a backup phrase looks like (ordinary sentences break the run quickly). */
function looksLikePhrase(s: string) { let run = 0; for (const w of s.toLowerCase().split(/[^a-z]+/)) { if (!w) continue; run = BIP39.has(w) ? run + 1 : 0; if (run >= 12) return true; } return false; }

const chars = (s: string) => [...s].length;
const bad = (msg: string) => new MarkError("BAD_FEEDBACK", msg);

/** The JSON body for POST /feedback, checked like the server does (and for obvious secrets). */
export function buildFeedback(i: FeedbackInput) {
  const type = i.type ?? "feedback";
  if (!(FEEDBACK_TYPES as readonly string[]).includes(type)) throw bad(`--type must be one of ${FEEDBACK_TYPES.join(", ")}`);
  const message = typeof i.message === "string" ? i.message.trim() : "";
  if (!message) throw bad('a message is required: mark feedback "what happened" (or --message "...")');
  if (chars(message) > FEEDBACK_LIMITS.message) throw bad(`message is over ${FEEDBACK_LIMITS.message} characters`);
  const body: Record<string, string> = { type, message };
  for (const k of ["command", "errorCode", "contact"] as const) {
    const v = i[k]; if (v === undefined) continue;
    if (typeof v !== "string") throw bad(`${k} must be text`);
    const t = v.trim(); if (!t) continue;
    if (chars(t) > FEEDBACK_LIMITS[k]) throw bad(`${k} is over ${FEEDBACK_LIMITS[k]} characters`);
    body[k] = t;
  }
  const all = Object.values(body).join("\n");
  const hit = SECRET_PATTERNS.find(([re]) => re.test(all))?.[1] ?? (looksLikePhrase(all) ? "what looks like a backup phrase (12+ BIP-39 words in a row)" : undefined);
  if (hit) throw new MarkError("SECRET_IN_FEEDBACK", `refusing to send: the feedback contains ${hit}. Remove it and send again; never share keys or backup phrases.`);
  return i.includeMeta === false ? body : { ...body, ...feedbackMeta() };
}

/** The escrow server to send feedback to: --server, else --escrow-url, else this network's Mark config / MARK_ESCROW_URL /
 *  the built-in default (mainnet https://agentescrow.to). Reads only the config's escrowUrl; never opens or creates a key. */
export function feedbackServer(network: NetworkName, o: { server?: string; escrowUrl?: string } = {}): string {
  const given = o.server || o.escrowUrl; if (given) return normalizeUrl(given);
  let fromFile: string | undefined;
  try { const j = JSON.parse(fs.readFileSync(configPath(network), "utf8")); if (typeof j?.escrowUrl === "string" && j.escrowUrl) fromFile = j.escrowUrl; } catch { /* no config yet: defaults */ }
  const url = process.env.MARK_ESCROW_URL || fromFile || NETWORKS[network].defaultEscrowUrl;
  if (!url) throw new MarkError("ESCROW_URL_MISSING", `no escrow server for ${network}: pass --server <url>`);
  return normalizeUrl(url);
}

/** POST <server>/feedback. Returns the server's {id, receivedAt, type} plus what was sent (field names only, not the text). */
export async function submitFeedback(o: SubmitFeedbackOpts) {
  const body = buildFeedback(o); const server = normalizeUrl(o.serverUrl);
  let r: Response;
  try {
    r = await (o.fetchImpl ?? fetch)(`${server}/feedback`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-mark-version": MARK_VERSION, "user-agent": MARK_USER_AGENT },
      body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch (e: any) { throw new MarkError("ESCROW_UNREACHABLE", `could not reach ${server}/feedback: ${String(e?.message ?? e).slice(0, 200)}. Nothing was sent; try again later.`); }
  let j: any; try { j = await r.json(); } catch { j = null; }
  if (!r.ok) {
    if (r.status === 404) throw new MarkError("FEEDBACK_UNSUPPORTED", `${server} does not accept feedback (HTTP 404): it may run an older escrow server. Nothing was stored.`);
    throw new MarkError(typeof j?.code === "string" ? j.code : "ESCROW_ERROR", typeof j?.error === "string" ? j.error.slice(0, 300) : `HTTP ${r.status}`);
  }
  if (!j || typeof j.id !== "string") throw new MarkError("ESCROW_BAD_RESPONSE", `unexpected answer from ${server}/feedback (HTTP ${r.status})`);
  return { id: j.id, receivedAt: j.receivedAt ?? null, type: j.type ?? body.type, server, sent: Object.keys(body),
    note: "Thanks: the Agent Escrow team reads every report. Nothing secret was sent (no keys, wallet, balances or deal data)." + (body.contact ? "" : " Add --contact <handle> if you want a reply.") };
}
