// Plain http:// is allowed only to this machine: the escrow URL check and the house-header gate share one host list.
import test from "node:test"; import assert from "node:assert/strict";
import { normalizeUrl, LOOPBACK_HOSTS } from "../dist/src/config.js";
import { houseHeader } from "../dist/src/api/escrowApi.js";

test("loopback hosts: http allowed for localhost, 127.0.0.1 and [::1] only, in both places", () => {
  assert.deepEqual(LOOPBACK_HOSTS, ["localhost", "127.0.0.1", "[::1]"]);
  const K = "test-key"; // dummy value, not a secret
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(normalizeUrl(`http://${h}:4783/`), `http://${h}:4783`);
    assert.deepEqual(houseHeader(`http://${h}:4783`, { MARK_HOUSE_KEY: K }), { "x-escrow-house": K }, h);
  }
  for (const h of ["10.0.0.1", "127.0.0.2", "localhost.evil.example"]) {
    assert.throws(() => normalizeUrl(`http://${h}/`), (e) => e.code === "BAD_ESCROW_URL", h);
    assert.deepEqual(houseHeader(`http://${h}`, { MARK_HOUSE_KEY: K }), {}, h);
  }
});
