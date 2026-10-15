import test from "node:test";
import assert from "node:assert/strict";
import { validatePayoutInvoice, decodeInvoice, invoiceRange, maxOverpaySats } from "../dist/src/lightning/invoice.js";
import { makeInvoice } from "./helpers.mjs";

const code = (fn) => { try { fn(); return "OK"; } catch (e) { return e.code; } };
test("valid exact invoice passes", () => { const d = validatePayoutInvoice(makeInvoice({ sats: 1195 }), 1195, "bitcoin"); assert.equal(d.sats, 1195); });
test("above exact -> AMOUNT_MISMATCH", () => { assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1196 }), 1195, "bitcoin")), "AMOUNT_MISMATCH"); });
test("fee drift tolerance: exact-tol..exact accepted, below rejected", () => {
  // 1195 -> tol max(10, ceil(23.9)) = 24
  assert.deepEqual(invoiceRange(1195), { minInvoiceSats: 1171, maxInvoiceSats: 1195, recommendedInvoiceSats: 1193, toleranceSats: 24 });
  for (const s of [1195, 1194, 1193, 1171]) assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: s }), 1195, "bitcoin")), "OK");
  assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1170 }), 1195, "bitcoin")), "AMOUNT_MISMATCH");
  // the reported case: quote said 494, exact at approve time is 493 -> a 494 invoice fails, the recommended 492 passes
  assert.equal(invoiceRange(494).recommendedInvoiceSats, 492);
  assert.deepEqual([invoiceRange(493).minInvoiceSats, invoiceRange(493).maxInvoiceSats], [483, 493]);
  assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 492 }), 493, "bitcoin")), "OK");
  assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 494 }), 493, "bitcoin")), "AMOUNT_MISMATCH");
  assert.equal(maxOverpaySats(500), 15);
});
test("fractional sats -> AMOUNT_MISMATCH", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({ msat: 1195500 }), 1195, "bitcoin")), "AMOUNT_MISMATCH"));
test("expired -> INVOICE_EXPIRED", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195, ageSec: 7200, expiry: 3600 }), 1195, "bitcoin")), "INVOICE_EXPIRED"));
test("expiring within 10 min -> INVOICE_EXPIRED", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195, expiry: 300 }), 1195, "bitcoin")), "INVOICE_EXPIRED"));
test("amountless -> BAD_INVOICE", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({}), 1195, "bitcoin")), "BAD_INVOICE"));
test("wrong network -> BAD_INVOICE", () => { assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195, network: "mutinynet" }), 1195, "bitcoin")), "BAD_INVOICE"); assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195 }), 1195, "mutinynet")), "BAD_INVOICE"); });
test("garbage -> BAD_INVOICE", () => assert.equal(code(() => decodeInvoice("lnbc1garbage")), "BAD_INVOICE"));
