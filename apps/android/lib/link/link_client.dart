import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'proof.dart';

const protocolVersion = 1;
const appVersion = '0.1.0';

enum LinkStatus { unpaired, connecting, connected, offline, rejected }

/// Credentials for the paired desktop. The token is a secret: kept in secure storage, never logged.
class Pairing {
  Pairing(this.host, this.port, this.certSha256, this.token, this.desktopName);
  final String host;
  final int port;
  final String certSha256;
  final String token;
  final String desktopName;
}

/// Phone side of the LAN link (see docs/API.md). TLS cert is pinned: on first pairing we record the
/// fingerprint we saw and bind it into the code proof, so a MITM cannot complete pairing; afterwards any
/// other certificate is refused.
class LinkClient extends ChangeNotifier {
  LinkClient({FlutterSecureStorage? storage}) : _storage = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _storage;

  LinkStatus status = LinkStatus.unpaired;
  String? lastError;
  Pairing? pairing;
  String? _deviceId;
  String deviceName = 'Android phone';
  WebSocket? _ws;
  Timer? _hb, _retry;
  int _backoffSec = 1;
  bool _disposed = false;

  Future<String> _id() async {
    if (_deviceId != null) return _deviceId!;
    var id = await _storage.read(key: 'deviceId');
    if (id == null) {
      final r = Random.secure();
      id = List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      await _storage.write(key: 'deviceId', value: id);
    }
    return _deviceId = id;
  }

  Map<String, dynamic> _frame(String id, String type, Map<String, dynamic> payload) => {
        'v': protocolVersion,
        'id': '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 32)}',
        'ts': DateTime.now().millisecondsSinceEpoch,
        'from': id,
        'type': type,
        'payload': payload,
      };

  Map<String, dynamic> _device(String id) =>
      {'deviceId': id, 'kind': 'android', 'name': deviceName, 'appVersion': appVersion};

  /// Load saved pairing and connect in the background.
  Future<void> start() async {
    final host = await _storage.read(key: 'host');
    final token = await _storage.read(key: 'token');
    final fp = await _storage.read(key: 'fp');
    final port = int.tryParse(await _storage.read(key: 'port') ?? '');
    if (host != null && token != null && fp != null && port != null) {
      pairing = Pairing(host, port, fp, token, await _storage.read(key: 'desktopName') ?? 'Desktop');
      _connectLoop();
    }
  }

  /// First-time pairing. Returns null on success or a human-readable error.
  Future<String?> pair(String host, int port, String code) async {
    status = LinkStatus.connecting;
    lastError = null;
    notifyListeners();
    String? observedFp;
    final id = await _id();
    try {
      final ws = await _open(host, port, pinned: null, onFp: (f) => observedFp = f);
      final result = Completer<String?>();
      late StreamSubscription sub;
      sub = ws.listen((raw) async {
        final m = jsonDecode(raw as String) as Map<String, dynamic>;
        final p = m['payload'] as Map<String, dynamic>;
        switch (m['type']) {
          case 'auth.challenge':
            ws.add(jsonEncode(_frame(id, 'pair.request', {
              'device': _device(id),
              'pairingCodeProof': pairProof(code, p['nonce'] as String, id, observedFp!),
            })));
          case 'pair.accept':
            final name = (p['device'] as Map)['name'] as String;
            await _persist(host, port, observedFp!, p['authToken'] as String, name);
            result.complete(null);
          case 'pair.reject':
            result.complete(_reason(p['reason'] as String));
        }
      }, onError: (e) => result.complete('Connection error'), onDone: () {
        if (!result.isCompleted) result.complete('Connection closed');
      });
      final err = await result.future.timeout(const Duration(seconds: 15), onTimeout: () => 'Timed out');
      await sub.cancel();
      await ws.close();
      if (err == null) {
        _connectLoop();
        return null;
      }
      status = LinkStatus.unpaired;
      lastError = err;
      notifyListeners();
      return err;
    } catch (e) {
      status = LinkStatus.unpaired;
      lastError = 'Could not reach $host:$port';
      notifyListeners();
      return lastError;
    }
  }

  String _reason(String r) => switch (r) {
        'bad_proof' => 'Wrong code',
        'expired' => 'Code expired. Start pairing again on the desktop',
        'locked' => 'Too many attempts. Start pairing again on the desktop',
        'revoked' => 'This phone was revoked on the desktop',
        'unknown_device' => 'This phone is no longer paired. Pair again',
        _ => 'Rejected ($r)',
      };

  Future<void> _persist(String host, int port, String fp, String token, String name) async {
    await _storage.write(key: 'host', value: host);
    await _storage.write(key: 'port', value: '$port');
    await _storage.write(key: 'fp', value: fp);
    await _storage.write(key: 'token', value: token);
    await _storage.write(key: 'desktopName', value: name);
    pairing = Pairing(host, port, fp, token, name);
  }

  Future<WebSocket> _open(String host, int port, {String? pinned, required void Function(String) onFp}) {
    final client = HttpClient()
      ..badCertificateCallback = (cert, h, p) {
        final fp = sha256.convert(cert.der).toString();
        onFp(fp);
        return pinned == null || fp == pinned; // first pairing trusts-on-first-use, bound by the proof
      };
    return WebSocket.connect('wss://$host:$port', customClient: client)
        .timeout(const Duration(seconds: 8));
  }

  Future<void> _connectLoop() async {
    if (_disposed || pairing == null) return;
    final p = pairing!;
    status = LinkStatus.connecting;
    notifyListeners();
    final id = await _id();
    try {
      final ws = await _open(p.host, p.port, pinned: p.certSha256, onFp: (_) {});
      _ws = ws;
      ws.listen((raw) {
        final m = jsonDecode(raw as String) as Map<String, dynamic>;
        final pl = m['payload'] as Map<String, dynamic>;
        switch (m['type']) {
          case 'auth.challenge':
            ws.add(jsonEncode(_frame(id, 'auth.hello', {
              'device': _device(id),
              'proof': authProof(p.token, pl['nonce'] as String, id),
            })));
          case 'auth.ok':
            status = LinkStatus.connected;
            _backoffSec = 1;
            _hb?.cancel();
            _hb = Timer.periodic(const Duration(seconds: 15),
                (_) => ws.add(jsonEncode(_frame(id, 'heartbeat', {}))));
            notifyListeners();
          case 'pair.reject':
            final r = pl['reason'] as String;
            if (r == 'revoked' || r == 'unknown_device') {
              forget(); // desktop no longer trusts us; don't hammer it
              lastError = _reason(r);
              status = LinkStatus.rejected;
              notifyListeners();
            }
        }
      }, onDone: _onClosed, onError: (_) => _onClosed());
    } catch (_) {
      _onClosed();
    }
  }

  void _onClosed() {
    _hb?.cancel();
    _ws = null;
    if (_disposed || pairing == null) return;
    status = LinkStatus.offline;
    notifyListeners();
    _retry?.cancel();
    _retry = Timer(Duration(seconds: _backoffSec), _connectLoop);
    _backoffSec = min(_backoffSec * 2, 30);
  }

  Future<void> forget() async {
    _retry?.cancel();
    _hb?.cancel();
    await _ws?.close();
    _ws = null;
    pairing = null;
    for (final k in ['host', 'port', 'fp', 'token', 'desktopName']) {
      await _storage.delete(key: k);
    }
    if (status != LinkStatus.rejected) status = LinkStatus.unpaired;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _hb?.cancel();
    _ws?.close();
    super.dispose();
  }
}
