// Escrow co-signing under the 0.3.1 dependency tree, on spend PSBTs built by the escrow server's own core (ark-rs, offline
// VTXO): release with fee (seller+buyer), release via arbiter, refund via arbiter. @satora/swap 1.8.1 / @arkade-os/sdk 0.5.x
// reject these ("witnessScript without P2WSH"); Mark's signer must still produce what the server accepts.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
import { Transaction } from "@scure/btc-signer"; import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js"; import { sha256 } from "@noble/hashes/sha2.js";
import { signEscrowArkTx as libArk, signEscrowCheckpoints as libCps } from "@satora/swap";
import { signEscrowArkTx, signEscrowCheckpoints } from "../dist/src/crypto/escrowSign.js";

const F = JSON.parse(fs.readFileSync(new URL("./fixtures/escrow-spend-psbts.json", import.meta.url), "utf8"));
const OPTS = { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true };
const parse = (b) => Transaction.fromPSBT(base64.decode(b), OPTS);
const sk = (b) => new Uint8Array(32).fill(b); const pk = (b) => hex.encode(schnorr.getPublicKey(sk(b)));
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const tapLeafHash = (script, v) => { const tag = sha256(new TextEncoder().encode("TapLeaf")); return sha256(concat(tag, tag, Uint8Array.of(v), Uint8Array.of(script.length), script)); };
/** Same check as escrow-server src/lib/psbt.ts hasValidSig (what addSig requires). */
function hasValidSig(b64, xonly) {
  const t = parse(b64); const i = t.getInput(0); const ps = [], am = [];
  for (let j = 0; j < t.inputsLength; j++) { const w = t.getInput(j).witnessUtxo; ps.push(w.script); am.push(w.amount); }
  for (const [k, sig] of i.tapScriptSig || []) {
    if (hex.encode(k.pubKey) !== xonly) continue;
    const leaf = (i.tapLeafScript || []).map(([, sc]) => ({ script: sc.slice(0, -1), ver: sc[sc.length - 1] })).find((l) => hex.encode(tapLeafHash(l.script, l.ver)) === hex.encode(k.leafHash));
    if (leaf && schnorr.verify(sig.slice(0, 64), t.preimageWitnessV1(0, ps, sig.length === 65 ? sig[64] : 0, am, undefined, leaf.script, leaf.ver), k.pubKey)) return true;
  }
  return false;
}
const shape = (b64) => { const t = parse(b64); const x = []; for (let j = 0; j < t.inputsLength; j++) { const i = { ...t.getInput(j) }; delete i.tapScriptSig; x.push(i); }
  return JSON.stringify({ x, id: t.id, outs: t.outputsLength }, (_k, v) => v instanceof Uint8Array ? hex.encode(v) : typeof v === "bigint" ? String(v) : v); };

test("fixtures are the server's real shape: taproot inputs carrying witnessScript + tapLeafScript", () => {
  for (const c of Object.values(F.cases)) { const i = parse(c.arkTx).getInput(0); assert.ok(i.witnessScript && i.tapLeafScript?.length); assert.equal(i.witnessUtxo.script[0], 0x51); }
});
test("upstream regression is still there: @satora/swap's own signers reject the server's PSBTs (remove the fallback when this fails)", () => {
  const c = F.cases.release_fee;
  assert.throws(() => libArk(c.arkTx, sk(1)), /witnessScript without P2WSH/); assert.throws(() => libCps(c.checkpoints, sk(1)), /witnessScript without P2WSH/);
});
for (const [name, c] of Object.entries(F.cases)) test(`Mark signs ${name} (${c.signerSet}) for both signers: valid sig, same txid and fields, same shape as 0.3.0`, () => {
  for (const s of c.signers) {
    const a = signEscrowArkTx(c.arkTx, sk(s)); const cps = signEscrowCheckpoints(c.checkpoints, sk(s));
    assert.ok(hasValidSig(a.signedPsbt, pk(s)), "ark tx signature verifies like the server's addSig check");
    assert.equal(parse(a.signedPsbt).id, parse(c.arkTx).id); assert.equal(a.txid, parse(c.arkTx).id);
    assert.equal(shape(a.signedPsbt), shape(c.arkTx), "nothing but the signature changed");
    assert.equal(cps.length, c.checkpoints.length);
    cps.forEach((cp, k) => { assert.ok(hasValidSig(cp, pk(s))); assert.equal(shape(cp), shape(c.checkpoints[k])); });
    assert.ok(!hasValidSig(a.signedPsbt, pk(9)));
  }
  const old = F.signedBy030[name]; const s0 = c.signers[0];
  assert.ok(hasValidSig(old.arkTx, pk(s0)), "0.3.0 fixture sanity");
  assert.equal(shape(signEscrowArkTx(c.arkTx, sk(s0)).signedPsbt), shape(old.arkTx)); assert.equal(signEscrowArkTx(c.arkTx, sk(s0)).signedPsbt.length, old.arkTx.length);
  assert.equal(signEscrowCheckpoints(c.checkpoints, sk(s0))[0].length, old.checkpoints[0].length);
});
test("other signing errors are not swallowed", () => {
  assert.throws(() => signEscrowArkTx("not-a-psbt", sk(1))); assert.throws(() => signEscrowCheckpoints(["%%"], sk(1)));
});
test("fallback signs only a taproot script-path input 0 (never a P2WPKH or a bare input with a bogus witnessScript)", () => {
  const t = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true });
  t.addInput({ txid: new Uint8Array(32).fill(4), index: 0, witnessUtxo: { script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(5)]), amount: 1000n }, witnessScript: new Uint8Array([0x51]) });
  t.addOutput({ script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(6)]), amount: 900n });
  const b = base64.encode(t.toPSBT());
  assert.throws(() => signEscrowArkTx(b, sk(1)), /refusing to sign/); assert.throws(() => signEscrowCheckpoints([b], sk(1)), /refusing to sign/);
});
