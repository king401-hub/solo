import 'dart:convert';
import 'package:crypto/crypto.dart';

/// Mirrors apps/desktop/src/main/link/pairing.ts. Test vectors live in test/proof_test.dart
/// and in apps/desktop/src/main/link/link.test.ts; both must stay identical.
String _hmacHex(String key, String msg) =>
    Hmac(sha256, utf8.encode(key)).convert(utf8.encode(msg)).toString();

String pairProof(String code, String nonce, String deviceId, String certSha256) =>
    _hmacHex(code, 'solo-pair-v1|$nonce|$deviceId|$certSha256');

String authProof(String token, String nonce, String deviceId) =>
    _hmacHex(token, 'solo-auth-v1|$nonce|$deviceId');
