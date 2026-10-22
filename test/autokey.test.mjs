import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openCtx } from "../dist/src/core/context.js";
import { walletFile, openOrCreateKeystore } from "../dist/src/crypto/keystore.js";
import { dataDir } from "../dist/src/config.js";
import { tmpHome } from "./mockApi.mjs";

const opts = { escrowUrl: "https://escrow.test", fetchImpl: async () => { throw new Error("no network"); } };

test("first start auto-creates the key (0600 file, 0700 dir) and logs only path + pubkey", async () => {
  tmpHome(); const dir = dataDir("mutinynet");
  assert.equal(fs.existsSync(walletFile(dir)), false);
  const writes = []; const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  let c; try { c = await openCtx("mutinynet", opts); } finally { process.stderr.write = orig; }
  assert.match(c.pubkey, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(walletFile(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const log = writes.join("");
  assert.match(log, /created new agent key/); assert.ok(log.includes(c.pubkey)); assert.ok(log.includes(walletFile(dir)));
  const { mnemonic } = openOrCreateKeystore(dir);
  for (const w of mnemonic.split(" ")) assert.ok(!new RegExp(`\\b${w}\\b`).test(log.replace(/\/[^\s)]*/g, "")), "mnemonic word leaked");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("second start loads the same pubkey and leaves the key file byte-identical", async () => {
  tmpHome(); const dir = dataDir("mutinynet");
  const a = await openCtx("mutinynet", opts); const before = fs.readFileSync(walletFile(dir));
  const b = await openCtx("mutinynet", opts);
  assert.equal(b.pubkey, a.pubkey); assert.deepEqual(fs.readFileSync(walletFile(dir)), before);
  assert.equal(openOrCreateKeystore(dir).created, false);
});

test("concurrent first starts converge on one key", async () => {
  tmpHome(); const dir = dataDir("mutinynet");
  const r = await Promise.all([1, 2, 3, 4].map(() => openCtx("mutinynet", opts)));
  assert.equal(new Set(r.map((c) => c.pubkey)).size, 1);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("exclusive create never overwrites an existing key file", async () => {
  tmpHome(); const dir = dataDir("mutinynet");
  const a = await openCtx("mutinynet", opts); const before = fs.readFileSync(walletFile(dir));
  const { createKeystore, resolvePassword } = await import("../dist/src/crypto/keystore.js");
  assert.throws(() => createKeystore(dir, resolvePassword(dir, false)), (e) => e.code === "EXISTS");
  assert.deepEqual(fs.readFileSync(walletFile(dir)), before);
  assert.equal((await openCtx("mutinynet", opts)).pubkey, a.pubkey);
  assert.ok(path.isAbsolute(dir));
});
