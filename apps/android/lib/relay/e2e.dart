import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as c;
import 'package:cryptography/cryptography.dart';

/// Dart mirror of packages/crypto/src/index.ts. Interop vectors are tested in test/e2e_test.dart and must match the
/// TypeScript tests byte for byte. Primitives: Ed25519, X25519, HKDF-SHA256, AES-256-GCM, HMAC-SHA256.

String b64u(List<int> b) => base64Url.encode(b).replaceAll('=', '');
Uint8List unb64u(String s) => Uint8List.fromList(base64Url.decode(base64Url.normalize(s)));

final _ed = Ed25519();
final _x = X25519();
final _aead = AesGcm.with256bits(); // 12-byte nonce, 16-byte tag; same layout as the desktop (ciphertext || tag)
final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 64);

// ---- identity -------------------------------------------------------------------------------------------

String idOf(String pub) => c.sha256.convert(unb64u(pub)).toString();

class Identity {
  Identity(this.seed, this.pub, this.id, this._pair);
  final String seed; // base64url, SECRET
  final String pub; // base64url
  final String id; // SHA-256(pub) hex
  final SimpleKeyPair _pair;
}

Future<Identity> identityFromSeed(String seed) async {
  final pair = await _ed.newKeyPairFromSeed(unb64u(seed));
  final pub = b64u((await pair.extractPublicKey()).bytes);
  return Identity(seed, pub, idOf(pub), pair);
}

Future<Identity> generateIdentity() {
  final r = Random.secure();
  return identityFromSeed(b64u(List<int>.generate(32, (_) => r.nextInt(256))));
}

Future<String> signText(Identity i, String text) async =>
    b64u((await _ed.sign(utf8.encode(text), keyPair: i._pair)).bytes);

Future<bool> verifyText(String pub, String text, String sig) async {
  try {
    return await _ed.verify(
      utf8.encode(text),
      signature: Signature(unb64u(sig), publicKey: SimplePublicKey(unb64u(pub), type: KeyPairType.ed25519)),
    );
  } catch (_) {
    return false;
  }
}

// ---- ephemeral X25519 + HKDF -------------------------------------------------------------------------------

class Eph {
  Eph(this.priv, this.pub, this._pair);
  final String priv;
  final String pub;
  final SimpleKeyPair _pair;
}

Future<Eph> ephFromPriv(String priv) async {
  final pair = await _x.newKeyPairFromSeed(unb64u(priv));
  return Eph(priv, b64u((await pair.extractPublicKey()).bytes), pair);
}

Future<Eph> newEph() {
  final r = Random.secure();
  return ephFromPriv(b64u(List<int>.generate(32, (_) => r.nextInt(256))));
}

Future<List<int>> dh(Eph me, String peerPub) async {
  final s = await _x.sharedSecretKey(keyPair: me._pair, remotePublicKey: SimplePublicKey(unb64u(peerPub), type: KeyPairType.x25519));
  return s.extractBytes();
}

Future<List<int>> hkdf64(List<int> ikm, List<int> salt, String info) async =>
    (await _hkdf.deriveKey(secretKey: SecretKey(ikm), nonce: salt, info: utf8.encode(info))).extractBytes();

// ---- AEAD ---------------------------------------------------------------------------------------------------

Uint8List _nonceFor(int counter) {
  final n = Uint8List(12);
  ByteData.view(n.buffer).setUint64(4, counter, Endian.big);
  return n;
}

Future<String> aeadSeal(List<int> key, int counter, String aad, String plaintext) async {
  final box = await _aead.encrypt(utf8.encode(plaintext), secretKey: SecretKey(key), nonce: _nonceFor(counter), aad: utf8.encode(aad));
  return b64u([...box.cipherText, ...box.mac.bytes]);
}

Future<String?> aeadOpen(List<int> key, int counter, String aad, String ct) async {
  try {
    final raw = unb64u(ct);
    if (raw.length < 16) return null;
    final box = SecretBox(raw.sublist(0, raw.length - 16), nonce: _nonceFor(counter), mac: Mac(raw.sublist(raw.length - 16)));
    return utf8.decode(await _aead.decrypt(box, secretKey: SecretKey(key), aad: utf8.encode(aad)));
  } catch (_) {
    return null;
  }
}

// ---- session ------------------------------------------------------------------------------------------------

class Session {
  Session(this._sendKey, this._recvKey, this.localId, this.peerId);
  final List<int> _sendKey, _recvKey;
  final String localId, peerId;
  int _sendCtr = 0;
  int _recvCtr = -1;

  Future<({int c, String ct})> seal(String plaintext) async {
    final n = _sendCtr++;
    return (c: n, ct: await aeadSeal(_sendKey, n, 'solo-data|$localId|$peerId', plaintext));
  }

  /// Null for tampered, wrong-key, replayed or out-of-order frames.
  Future<String?> open(int counter, String ct) async {
    if (counter <= _recvCtr) return null;
    final pt = await aeadOpen(_recvKey, counter, 'solo-data|$peerId|$localId', ct);
    if (pt != null) _recvCtr = counter;
    return pt;
  }
}

String _hs1Text(String i, String r, String eph, String n) => 'solo-hs1|$i|$r|$eph|$n';
String _hs2Text(String i, String r, String ephI, String ephR, String n) => 'solo-hs2|$i|$r|$ephI|$ephR|$n';

class HsState {
  HsState(this.eph, this.n);
  final Eph eph;
  final String n;
}

Future<Session> _derive(List<int> shared, String n, String initiatorId, String responderId, bool initiator) async {
  final km = await hkdf64(shared, unb64u(n), 'solo-session-v1|$initiatorId|$responderId');
  final i2r = km.sublist(0, 32), r2i = km.sublist(32, 64);
  return initiator ? Session(i2r, r2i, initiatorId, responderId) : Session(r2i, i2r, responderId, initiatorId);
}

/// Step 1 (initiator).
Future<({Map<String, String> msg, HsState state})> hsInitiate(Identity me, String peerId, {Eph? eph, String? n}) async {
  final e = eph ?? await newEph();
  final nonce = n ?? b64u(List<int>.generate(16, (_) => Random.secure().nextInt(256)));
  final sig = await signText(me, _hs1Text(me.id, peerId, e.pub, nonce));
  return (msg: {'eph': e.pub, 'n': nonce, 'sig': sig}, state: HsState(e, nonce));
}

/// Step 2 (responder): verify the initiator against its trusted key.
Future<({Map<String, String> msg, Session session})?> hsRespond(
    Identity me, String initiatorId, String initiatorPub, Map<String, dynamic> m, {Eph? eph}) async {
  if (idOf(initiatorPub) != initiatorId) return null;
  if (!await verifyText(initiatorPub, _hs1Text(initiatorId, me.id, m['eph'] as String, m['n'] as String), m['sig'] as String)) return null;
  final e = eph ?? await newEph();
  try {
    final shared = await dh(e, m['eph'] as String);
    final sig = await signText(me, _hs2Text(initiatorId, me.id, m['eph'] as String, e.pub, m['n'] as String));
    return (msg: {'eph': e.pub, 'sig': sig}, session: await _derive(shared, m['n'] as String, initiatorId, me.id, false));
  } catch (_) {
    return null;
  }
}

/// Step 3 (initiator).
Future<Session?> hsFinish(Identity me, String responderId, String responderPub, HsState st, Map<String, dynamic> m) async {
  if (idOf(responderPub) != responderId) return null;
  if (!await verifyText(responderPub, _hs2Text(me.id, responderId, st.eph.pub, m['eph'] as String, st.n), m['sig'] as String)) return null;
  try {
    return await _derive(await dh(st.eph, m['eph'] as String), st.n, me.id, responderId, true);
  } catch (_) {
    return null;
  }
}

// ---- remote pairing code ------------------------------------------------------------------------------------

String normalizeCode(String input) => input
    .toUpperCase()
    .replaceAll('O', '0')
    .replaceAll(RegExp('[IL]'), '1')
    .replaceAll(RegExp('[^0-9A-Z]'), '')
    .replaceAll('U', 'V');

String _hmacHex(String key, String msg) => c.Hmac(c.sha256, utf8.encode(key)).convert(utf8.encode(msg)).toString();

String rendezvousKey(String code) => _hmacHex(normalizeCode(code), 'solo-rdv-v1').substring(0, 32);

String pairingProof(String code, String role, String hostId, String joinerId, String nonce, String joinerPub, String hostPub) =>
    _hmacHex(normalizeCode(code), 'solo-rpair-v1|$role|$hostId|$joinerId|$nonce|$joinerPub|$hostPub');

bool safeEqual(String a, String b) {
  if (a.length != b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) {
    r |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return r == 0;
}

String randomNonce() => b64u(List<int>.generate(16, (_) => Random.secure().nextInt(256)));
