import 'dart:convert';
import 'package:crypto/crypto.dart';

/// Mirrors apps/desktop/src/main/link/pairing.ts. Test vectors live in test/widget_test.dart
/// and in apps/desktop/src/main/link/link.test.ts; both must stay identical.
String _hmacHex(String key, String msg) =>
    Hmac(sha256, utf8.encode(key)).convert(utf8.encode(msg)).toString();

String pairProof(String code, String nonce, String deviceId, String certSha256) =>
    _hmacHex(code, 'solo-pair-v1|$nonce|$deviceId|$certSha256');

String authProof(String token, String nonce, String deviceId) =>
    _hmacHex(token, 'solo-auth-v1|$nonce|$deviceId');

/// 4-digit confirmation shown on both screens during code-free pairing.
String sas(String nonce, String certSha256) {
  final d = sha256.convert(utf8.encode('solo-sas-v1|$nonce|$certSha256')).bytes;
  final n = (d[0] << 24 | d[1] << 16 | d[2] << 8 | d[3]) & 0xFFFFFFFF;
  return (n % 10000).toString().padLeft(4, '0');
}
