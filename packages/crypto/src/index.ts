/**
 * Solo end-to-end crypto (Node). Mirrored in Dart (apps/android/lib/relay/e2e.dart); the shared test vectors in
 * e2e.test.ts are repeated in the Dart tests. Primitives: Ed25519 (identity/signatures), X25519 (ephemeral key
 * agreement), HKDF-SHA256, AES-256-GCM, HMAC-SHA256. No custom primitives.
 *
 * Model: every device owns an Ed25519 identity; its device id is SHA-256(public key), so an id cannot be claimed
 * without the key. Two devices that have exchanged public keys (by pairing) open a session with a signed ephemeral
 * X25519 handshake (mutual authentication + forward secrecy), then exchange AES-256-GCM frames. A relay in the
 * middle only ever sees ciphertext.
 */
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman,
  hkdfSync, randomBytes, sign, timingSafeEqual, verify,
} from "node:crypto";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

// ---- Identity (Ed25519) -----------------------------------------------------------------------------

export interface Identity {
  /** 32-byte Ed25519 seed, base64url. SECRET. */
  seed: string;
  /** 32-byte Ed25519 public key, base64url. */
  pub: string;
  /** SHA-256(pub), hex. This is the device id on every transport. */
  id: string;
}

const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");

export const idOf = (pub: string) => createHash("sha256").update(unb64u(pub)).digest("hex");

export function identityFromSeed(seed: string): Identity {
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8, unb64u(seed)]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "jwk" }).x!;
  return { seed, pub, id: idOf(pub) };
}

export function generateIdentity(): Identity {
  return identityFromSeed(b64u(randomBytes(32)));
}

const edPriv = (i: Identity) => createPrivateKey({ key: Buffer.concat([ED_PKCS8, unb64u(i.seed)]), format: "der", type: "pkcs8" });
const edPub = (pub: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });

export function signText(i: Identity, text: string): string {
  return b64u(sign(null, Buffer.from(text, "utf8"), edPriv(i)));
}
export function verifyText(pub: string, text: string, sig: string): boolean {
  try { return verify(null, Buffer.from(text, "utf8"), edPub(pub), unb64u(sig)); } catch { return false; }
}

// ---- Ephemeral X25519 + HKDF ------------------------------------------------------------------------

export interface Eph { priv: string; pub: string }

export function ephFromPriv(priv: string): Eph {
  const k = createPrivateKey({ key: Buffer.concat([X_PKCS8, unb64u(priv)]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(k).export({ format: "jwk" }).x! };
}
export const newEph = (): Eph => ephFromPriv(b64u(randomBytes(32)));

export function dh(me: Eph, peerPub: string): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.concat([X_PKCS8, unb64u(me.priv)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerPub }, format: "jwk" });
  return diffieHellman({ privateKey, publicKey });
}

export function hkdf64(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), 64));
}

// ---- AEAD frames --------------------------------------------------------------------------------------

export interface Frame { c: number; ct: string }

const nonceFor = (counter: number) => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
};

/**
 * AES-256-GCM with a 12-byte counter nonce and 16-byte tag (ciphertext || tag). ChaCha20-Poly1305 was rejected because
 * Electron's BoringSSL-backed Node does not provide it; AES-GCM is available in Electron, Node and Dart.
 */
export function aeadSeal(key: Uint8Array, counter: number, aad: string, plaintext: string): string {
  const c = createCipheriv("aes-256-gcm", key, nonceFor(counter), { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final(), c.getAuthTag()]);
  return b64u(ct);
}

export function aeadOpen(key: Uint8Array, counter: number, aad: string, ct: string): string | null {
  try {
    const raw = unb64u(ct);
    if (raw.length < 16) return null;
    const d = createDecipheriv("aes-256-gcm", key, nonceFor(counter), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
  } catch { return null; }
}

/**
 * Exercises every primitive once. Call at start-up in the real runtime (Electron differs from plain Node): returns an
 * error message if anything is unavailable, so the app can say so instead of failing on the first message.
 */
export function selfTest(): string | null {
  try {
    const a = generateIdentity(), b = generateIdentity();
    const { msg, state } = hsInitiate(a, b.id);
    const resp = hsRespond(b, a.id, a.pub, msg);
    const sa = resp && hsFinish(a, b.id, b.pub, state, resp.msg);
    if (!resp || !sa) return "handshake failed";
    const f = sa.seal("ping");
    if (resp.session.open(f) !== "ping") return "encrypted round trip failed";
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---- Session ------------------------------------------------------------------------------------------

/** One direction-separated encrypted channel between two paired devices. Counters stop replay and reordering. */
export class Session {
  private sendCtr = 0;
  private recvCtr = -1;
  constructor(private sendKey: Buffer, private recvKey: Buffer, readonly localId: string, readonly peerId: string) {}

  seal(plaintext: string): Frame {
    const c = this.sendCtr++;
    return { c, ct: aeadSeal(this.sendKey, c, `solo-data|${this.localId}|${this.peerId}`, plaintext) };
  }

  /** Returns null for tampered, wrong-key or replayed/out-of-order frames. */
  open(f: Frame): string | null {
    if (!Number.isInteger(f.c) || f.c <= this.recvCtr || f.c > Number.MAX_SAFE_INTEGER) return null;
    const pt = aeadOpen(this.recvKey, f.c, `solo-data|${this.peerId}|${this.localId}`, f.ct);
    if (pt !== null) this.recvCtr = f.c;
    return pt;
  }
}

const hs1Text = (i: string, r: string, eph: string, n: string) => `solo-hs1|${i}|${r}|${eph}|${n}`;
const hs2Text = (i: string, r: string, ephI: string, ephR: string, n: string) => `solo-hs2|${i}|${r}|${ephI}|${ephR}|${n}`;

export interface Hs1 { eph: string; n: string; sig: string }
export interface Hs2 { eph: string; sig: string }
export interface HsState { eph: Eph; n: string }

function derive(shared: Buffer, n: string, initiatorId: string, responderId: string, role: "initiator" | "responder"): Session {
  const km = hkdf64(shared, unb64u(n), `solo-session-v1|${initiatorId}|${responderId}`);
  const i2r = km.subarray(0, 32), r2i = km.subarray(32, 64);
  return role === "initiator"
    ? new Session(i2r, r2i, initiatorId, responderId)
    : new Session(r2i, i2r, responderId, initiatorId);
}

/** Step 1 (initiator): signed ephemeral key. */
export function hsInitiate(me: Identity, peerId: string, ephOverride?: Eph, nOverride?: string): { msg: Hs1; state: HsState } {
  const eph = ephOverride ?? newEph();
  const n = nOverride ?? b64u(randomBytes(16));
  return { msg: { eph: eph.pub, n, sig: signText(me, hs1Text(me.id, peerId, eph.pub, n)) }, state: { eph, n } };
}

/** Step 2 (responder): verify the initiator against its trusted public key, answer, and derive the session. */
export function hsRespond(me: Identity, initiatorId: string, initiatorPub: string, m: Hs1, ephOverride?: Eph): { msg: Hs2; session: Session } | null {
  if (idOf(initiatorPub) !== initiatorId) return null;
  if (!verifyText(initiatorPub, hs1Text(initiatorId, me.id, m.eph, m.n), m.sig)) return null;
  const eph = ephOverride ?? newEph();
  let shared: Buffer;
  try { shared = dh(eph, m.eph); } catch { return null; }
  return {
    msg: { eph: eph.pub, sig: signText(me, hs2Text(initiatorId, me.id, m.eph, eph.pub, m.n)) },
    session: derive(shared, m.n, initiatorId, me.id, "responder"),
  };
}

/** Step 3 (initiator): verify the responder and derive the session. */
export function hsFinish(me: Identity, responderId: string, responderPub: string, st: HsState, m: Hs2): Session | null {
  if (idOf(responderPub) !== responderId) return null;
  if (!verifyText(responderPub, hs2Text(me.id, responderId, st.eph.pub, m.eph, st.n), m.sig)) return null;
  let shared: Buffer;
  try { shared = dh(st.eph, m.eph); } catch { return null; }
  return derive(shared, st.n, me.id, responderId, "initiator");
}

// ---- Remote pairing code ----------------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 12 Crockford-base32 characters (60 bits) shown as XXXX-XXXX-XXXX. */
export function newPairingCode(): string {
  const b = randomBytes(12);
  const s = Array.from(b, (x) => CROCKFORD[x & 31]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Forgiving entry: case-insensitive, ignores separators, maps O->0 and I/L->1 like Crockford base32. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "").replace(/U/g, "V");
}

/** What the relay sees instead of the code: it can match a joiner to a host without learning the code. */
export function rendezvousKey(code: string): string {
  return createHmac("sha256", normalizeCode(code)).update("solo-rdv-v1").digest("hex").slice(0, 32);
}

/** Proof of knowing the code, bound to both device ids, both public keys and the joiner's nonce. */
export function pairingProof(code: string, role: "req" | "ack", hostId: string, joinerId: string, nonce: string, joinerPub: string, hostPub: string): string {
  return createHmac("sha256", normalizeCode(code))
    .update(`solo-rpair-v1|${role}|${hostId}|${joinerId}|${nonce}|${joinerPub}|${hostPub}`)
    .digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomNonce = () => b64u(randomBytes(16));
