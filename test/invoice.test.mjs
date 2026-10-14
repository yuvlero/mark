import test from "node:test";
import assert from "node:assert/strict";
import { validatePayoutInvoice, decodeInvoice } from "../dist/src/lightning/invoice.js";
import { makeInvoice } from "./helpers.mjs";

const code = (fn) => { try { fn(); return "OK"; } catch (e) { return e.code; } };
test("valid exact invoice passes", () => { const d = validatePayoutInvoice(makeInvoice({ sats: 1195 }), 1195, "bitcoin"); assert.equal(d.sats, 1195); });
test("wrong amount -> AMOUNT_MISMATCH", () => { assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1200 }), 1195, "bitcoin")), "AMOUNT_MISMATCH"); assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1194 }), 1195, "bitcoin")), "AMOUNT_MISMATCH"); });
test("fractional sats -> AMOUNT_MISMATCH", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({ msat: 1195500 }), 1195, "bitcoin")), "AMOUNT_MISMATCH"));
test("expired -> INVOICE_EXPIRED", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195, ageSec: 7200, expiry: 3600 }), 1195, "bitcoin")), "INVOICE_EXPIRED"));
test("expiring within 10 min -> INVOICE_EXPIRED", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195, expiry: 300 }), 1195, "bitcoin")), "INVOICE_EXPIRED"));
test("amountless -> BAD_INVOICE", () => assert.equal(code(() => validatePayoutInvoice(makeInvoice({}), 1195, "bitcoin")), "BAD_INVOICE"));
test("wrong network -> BAD_INVOICE", () => { assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195, network: "mutinynet" }), 1195, "bitcoin")), "BAD_INVOICE"); assert.equal(code(() => validatePayoutInvoice(makeInvoice({ sats: 1195 }), 1195, "mutinynet")), "BAD_INVOICE"); });
test("garbage -> BAD_INVOICE", () => assert.equal(code(() => decodeInvoice("lnbc1garbage")), "BAD_INVOICE"));
