import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const PAIR_CODE_TTL_MS = 2 * 60_000;
export const PAIR_MAX_ATTEMPTS = 5;

const hmacHex = (key: string, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest("hex");

export function pairProof(code: string, nonce: string, deviceId: string, certSha256: string): string {
  return hmacHex(code, `solo-pair-v1|${nonce}|${deviceId}|${certSha256}`);
}
export function authProof(token: string, nonce: string, deviceId: string): string {
  return hmacHex(token, `solo-auth-v1|${nonce}|${deviceId}`);
}
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
export const newNonce = () => randomBytes(16).toString("hex");
export const newToken = () => randomBytes(32).toString("hex");

/** A single short-lived pairing code. Locks after too many failed attempts so 6 digits can't be brute-forced. */
export class PairingSession {
  readonly code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  readonly expiresAt: number;
  private attempts = 0;
  private used = false;
  constructor(private now: () => number = Date.now) { this.expiresAt = now() + PAIR_CODE_TTL_MS; }

  /** Returns "ok" | "expired" | "locked" | "bad_proof". A success burns the code. */
  verify(proof: string, nonce: string, deviceId: string, certSha256: string): "ok" | "expired" | "locked" | "bad_proof" {
    if (this.used || this.attempts >= PAIR_MAX_ATTEMPTS) return "locked";
    if (this.now() > this.expiresAt) return "expired";
    if (safeEqualHex(proof, pairProof(this.code, nonce, deviceId, certSha256))) { this.used = true; return "ok"; }
    this.attempts++;
    return "bad_proof";
  }
}
