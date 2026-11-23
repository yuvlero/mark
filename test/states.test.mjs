import { test } from "node:test";
import assert from "node:assert/strict";
import { SWAP_UNPAID, SWAP_PAID, SWAP_WAITING, SWAP_CLAIMABLE, SWAP_DONE, SWAP_FAILED } from "../dist/src/swap/states.js";
import { SWAP_CLAIMABLE as FROM_USECASES } from "../dist/src/core/usecases.js";

test("swap state groups keep their statuses and never overlap", () => {
  assert.deepEqual([...SWAP_UNPAID], ["pending"]);
  assert.deepEqual([...SWAP_PAID], ["clientfundingseen", "clientfunded"]);
  assert.deepEqual([...SWAP_WAITING], ["pending", "clientfundingseen", "clientfunded"]);
  assert.deepEqual([...SWAP_CLAIMABLE], ["serverfunded", "clientredeeming"]);
  assert.deepEqual([...SWAP_DONE], ["clientredeemed", "serverredeemed"]);
  assert.deepEqual([...SWAP_FAILED], ["expired", "clientrefunded", "clientfundedserverrefunded", "clientrefundedserverfunded", "clientrefundedserverrefunded", "serverwontfund", "clientinvalidfunded", "clientfundedtoolate"]);
  const all = [SWAP_UNPAID, SWAP_PAID, SWAP_CLAIMABLE, SWAP_DONE, SWAP_FAILED].flatMap((x) => [...x]);
  assert.equal(new Set(all).size, all.length);
  assert.equal(FROM_USECASES, SWAP_CLAIMABLE, "usecases keeps exporting SWAP_CLAIMABLE");
});
