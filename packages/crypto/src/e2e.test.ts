import { describe, expect, it } from "vitest";
import {
  Session, aeadOpen, aeadSeal, dh, ephFromPriv, generateIdentity, hkdf64, hsFinish, hsInitiate, hsRespond, identityFromSeed,
  idOf, newPairingCode, selfTest, normalizeCode, pairingProof, rendezvousKey, signText, verifyText,
} from "./index";

const b64u = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

describe("identity", () => {
  it("id is SHA-256 of the public key and the seed fully determines the identity", () => {
    const a = generateIdentity();
    expect(a.id).toBe(idOf(a.pub));
    expect(identityFromSeed(a.seed)).toEqual(a);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
  });
  it("signs and verifies; rejects tampering and wrong keys", () => {
    const a = generateIdentity(), b = generateIdentity();
    const sig = signText(a, "hello");
    expect(verifyText(a.pub, "hello", sig)).toBe(true);
    expect(verifyText(a.pub, "hellO", sig)).toBe(false);
    expect(verifyText(b.pub, "hello", sig)).toBe(false);
    expect(verifyText(a.pub, "hello", "!!!")).toBe(false);
  });
});

describe("handshake + session", () => {
  const A = generateIdentity(), B = generateIdentity();

  function connect() {
    const { msg, state } = hsInitiate(A, B.id);
    const resp = hsRespond(B, A.id, A.pub, msg)!;
    const sa = hsFinish(A, B.id, B.pub, state, resp.msg)!;
    return { sa, sb: resp.session };
  }

  it("both sides derive a working encrypted channel in both directions", () => {
    const { sa, sb } = connect();
    expect(sb.open(sa.seal("ping"))).toBe("ping");
    expect(sa.open(sb.seal("pong"))).toBe("pong");
    expect(sb.open(sa.seal("again"))).toBe("again");
  });

  it("rejects replays, reordering, tampering and cross-direction reflection", () => {
    const { sa, sb } = connect();
    const f1 = sa.seal("one"), f2 = sa.seal("two");
    expect(sb.open(f2)).toBe("two");
    expect(sb.open(f1)).toBeNull(); // older counter
    expect(sb.open(f2)).toBeNull(); // replay
    const f3 = sa.seal("three");
    expect(sb.open({ ...f3, ct: f3.ct.slice(0, -2) + "AA" })).toBeNull();
    const own = sa.seal("mine");
    expect(sa.open(own)).toBeNull(); // a device cannot accept its own frames reflected back
  });

  it("a different pair of devices cannot read it, and forged handshakes fail", () => {
    const C = generateIdentity();
    const { msg, state } = hsInitiate(A, B.id);
    expect(hsRespond(B, A.id, C.pub, msg)).toBeNull(); // wrong trusted key for A
    expect(hsRespond(C, A.id, A.pub, msg)).toBeNull(); // handshake was addressed to B, not C
    const resp = hsRespond(B, A.id, A.pub, msg)!;
    expect(hsFinish(A, B.id, C.pub, state, resp.msg)).toBeNull(); // responder impersonated
    expect(hsRespond(B, A.id, A.pub, { ...msg, n: "AAAAAAAAAAAAAAAAAAAAAA" })).toBeNull(); // nonce tampered
  });

  it("sessions are fresh each time (forward secrecy: new keys per handshake)", () => {
    const one = connect(), two = connect();
    const f = one.sa.seal("secret");
    expect(two.sb.open(f)).toBeNull();
  });
});

describe("pairing code", () => {
  it("has 60 bits as XXXX-XXXX-XXXX in the Crockford alphabet", () => {
    const c = newPairingCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(newPairingCode()).not.toBe(c);
  });
  it("normalises typing mistakes", () => {
    expect(normalizeCode("abcd-ef12-oil3")).toBe("ABCDEF12011" + "3");
    expect(rendezvousKey("k7qm-2x9d-4trw")).toBe(rendezvousKey("K7QM2X9D4TRW"));
  });
  it("proof is bound to code, role, both ids, both keys and the nonce", () => {
    const base = pairingProof("K7QM-2X9D-4TRW", "req", "h", "j", "n", "jp", "hp");
    for (const other of [
      pairingProof("K7QM-2X9D-4TRX", "req", "h", "j", "n", "jp", "hp"),
      pairingProof("K7QM-2X9D-4TRW", "ack", "h", "j", "n", "jp", "hp"),
      pairingProof("K7QM-2X9D-4TRW", "req", "x", "j", "n", "jp", "hp"),
      pairingProof("K7QM-2X9D-4TRW", "req", "h", "x", "n", "jp", "hp"),
      pairingProof("K7QM-2X9D-4TRW", "req", "h", "j", "m", "jp", "hp"),
      pairingProof("K7QM-2X9D-4TRW", "req", "h", "j", "n", "xx", "hp"),
      pairingProof("K7QM-2X9D-4TRW", "req", "h", "j", "n", "jp", "xx"),
    ]) expect(other).not.toBe(base);
  });
});

/** Cross-language vectors: apps/android/test/e2e_test.dart must contain exactly these expectations. */
describe("interop vectors (shared with Dart)", () => {
  const seedHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  it("ed25519 identity + signature (deterministic)", () => {
    const id = identityFromSeed(b64u(seedHex));
    console.log("VEC id.pub", id.pub, "id.id", id.id, "sig", signText(id, "solo-vector"));
    expect(id.id).toBe(idOf(id.pub));
  });
  it("x25519 shared secret, hkdf and aead (deterministic)", () => {
    const a = ephFromPriv(b64u("a".repeat(64))), b = ephFromPriv(b64u("b".repeat(64)));
    const s1 = dh(a, b.pub), s2 = dh(b, a.pub);
    expect(s1.equals(s2)).toBe(true);
    const km = hkdf64(s1, Buffer.from("00112233445566778899aabbccddeeff", "hex"), "solo-session-v1|I|R");
    const key = km.subarray(0, 32);
    const ct = aeadSeal(key, 7, "solo-data|I|R", "hello solo");
    expect(aeadOpen(key, 7, "solo-data|I|R", ct)).toBe("hello solo");
    expect(aeadOpen(key, 8, "solo-data|I|R", ct)).toBeNull();
    console.log("VEC a.pub", a.pub, "b.pub", b.pub, "shared", s1.toString("hex"), "km", km.toString("hex"), "ct", ct);
    console.log("VEC rdv", rendezvousKey("K7QM-2X9D-4TRW"), "proof", pairingProof("K7QM-2X9D-4TRW", "req", "host", "joiner", "nonce", "jp", "hp"));
  });
  it("selfTest passes in this runtime", () => { expect(selfTest()).toBeNull(); });
  it("Session class round-trips through the same primitives", () => {
    const k = Buffer.alloc(32, 1), k2 = Buffer.alloc(32, 2);
    const a = new Session(k, k2, "A", "B"), b = new Session(k2, k, "B", "A");
    expect(b.open(a.seal("x"))).toBe("x");
  });
});
