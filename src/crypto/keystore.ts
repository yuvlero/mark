/**
 * Encrypted-at-rest key store (scrypt + AES-256-GCM). Reusable: exposes the
 * mnemonic only to in-process signers (Arkade identity, swap provider, and
 * later an escrow co-signer). Never logs or prints secrets.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MarkError } from "../errors.js";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface Keystore { mnemonic: string; key: Buffer }

function deriveKey(pw: string, salt: Buffer) {
  return crypto.scryptSync(pw, salt, 32, SCRYPT);
}

export function encryptWith(key: Buffer, plaintext: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("base64") };
}
export function decryptWith(key: Buffer, blob: { iv: string; tag: string; ct: string }) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  d.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8");
}

/** Password: MARK_PASSWORD env, else MARK_PASSWORD_FILE, else <dir>/password (0600). */
export function resolvePassword(dir: string, createIfMissing: boolean, envName = "MARK_PASSWORD"): string {
  if (process.env[envName]) return process.env[envName]!;
  const f = process.env[envName + "_FILE"] || path.join(dir, "password");
  if (fs.existsSync(f)) {
    const st = fs.statSync(f);
    if ((st.mode & 0o077) !== 0) throw new MarkError("INSECURE_PASSWORD_FILE", `password file ${f} must be mode 0600`);
    return fs.readFileSync(f, "utf8").trim();
  }
  if (!createIfMissing) throw new MarkError("LOCKED", `no password: set ${envName} or ${envName}_FILE`);
  const pw = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(f, pw + "\n", { mode: 0o600 });
  return pw;
}

export function walletFile(dir: string) { return path.join(dir, "wallet.enc.json"); }

export function createKeystore(dir: string, password: string, importMnemonic?: string): Keystore {
  const f = walletFile(dir);
  if (fs.existsSync(f)) throw new MarkError("EXISTS", "wallet already exists");
  const mnemonic = importMnemonic ?? generateMnemonic(wordlist, 128);
  if (!validateMnemonic(mnemonic, wordlist)) throw new MarkError("BAD_MNEMONIC", "invalid mnemonic");
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const blob = { version: 1, kdf: "scrypt", salt: salt.toString("hex"), ...encryptWith(key, mnemonic) };
  fs.writeFileSync(f, JSON.stringify(blob) + "\n", { mode: 0o600 });
  return { mnemonic, key };
}

export function openKeystore(dir: string, password: string): Keystore {
  const f = walletFile(dir);
  if (!fs.existsSync(f)) throw new MarkError("NOT_INITIALIZED", "no wallet; run mark init");
  const blob = JSON.parse(fs.readFileSync(f, "utf8"));
  const key = deriveKey(password, Buffer.from(blob.salt, "hex"));
  try { return { mnemonic: decryptWith(key, blob), key }; }
  catch { throw new MarkError("BAD_PASSWORD", "could not decrypt wallet"); }
}
