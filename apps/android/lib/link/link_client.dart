import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'discovery.dart';
import 'link_api.dart';
import 'proof.dart';

export 'link_api.dart';

const protocolVersion = 1;
const appVersion = '0.1.0';

/// Phone side of the LAN link (see docs/API.md). The TLS cert is pinned: on first pairing we record the
/// fingerprint we saw and bind it into the proof (code) or confirmation digits (ask), so a MITM cannot
/// complete pairing unnoticed; afterwards any other certificate is refused.
///
/// In the app this runs inside the foreground-service isolate so it survives the UI being closed.
class LinkClient extends LinkApi {
  LinkClient({FlutterSecureStorage? storage, this.autoDiscover = false})
      : _storage = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _storage;
  final bool autoDiscover;

  LinkState _s = const LinkState();
  @override
  LinkState get state => _s;
  void _set(LinkState s) {
    _s = s;
    notifyListeners();
  }

  // Secrets / identity (not part of LinkState).
  String? _token, _certFp, _desktopId, _deviceId;
  Timer? _hb, _retry, _scan;
  WebSocket? _ws;
  int _backoffSec = 1;
  bool _disposed = false, _pairing = false;
  DateTime _noAskBefore = DateTime.fromMillisecondsSinceEpoch(0);

  LinkState _copy({
    LinkStatus? status,
    Object? lastError = _keep,
    Object? desktopName = _keep,
    Object? host = _keep,
    Object? port = _keep,
    String? deviceName,
    Object? sas = _keep,
    bool? autoPair,
    List<FoundDesktop>? discovered,
  }) =>
      LinkState(
        status: status ?? _s.status,
        lastError: identical(lastError, _keep) ? _s.lastError : lastError as String?,
        desktopName: identical(desktopName, _keep) ? _s.desktopName : desktopName as String?,
        host: identical(host, _keep) ? _s.host : host as String?,
        port: identical(port, _keep) ? _s.port : port as int?,
        deviceName: deviceName ?? _s.deviceName,
        sas: identical(sas, _keep) ? _s.sas : sas as String?,
        autoPair: autoPair ?? _s.autoPair,
        discovered: discovered ?? _s.discovered,
      );
  static const _keep = Object();

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
      {'deviceId': id, 'kind': 'android', 'name': _s.deviceName, 'appVersion': appVersion};

  /// Load saved settings/pairing, connect, and start looking for desktops if unpaired.
  Future<void> start() async {
    final name = await _storage.read(key: 'deviceName');
    final auto = await _storage.read(key: 'autoPair') == '1';
    _set(_copy(deviceName: name ?? _s.deviceName, autoPair: auto));
    final host = await _storage.read(key: 'host');
    final token = await _storage.read(key: 'token');
    final fp = await _storage.read(key: 'fp');
    final port = int.tryParse(await _storage.read(key: 'port') ?? '');
    if (host != null && token != null && fp != null && port != null) {
      _token = token;
      _certFp = fp;
      _desktopId = await _storage.read(key: 'desktopId');
      _set(_copy(host: host, port: port, desktopName: await _storage.read(key: 'desktopName') ?? 'Desktop'));
      _connectLoop();
    }
    if (autoDiscover) {
      _scan = Timer.periodic(const Duration(seconds: 20), (_) => _scanOnce());
      unawaited(_scanOnce());
    }
  }

  /// One discovery pass. When unpaired: list desktops and (if enabled) ask the first one to pair.
  /// When paired but offline: follow the desktop if its IP changed.
  Future<void> _scanOnce() async {
    if (_disposed || _pairing) return;
    if (_s.paired && _s.status == LinkStatus.connected) return;
    final found = await discoverDesktops();
    if (_disposed) return;
    _set(_copy(discovered: found));
    if (_s.paired) {
      final me = found.where((d) => d.id != null && d.id == _desktopId).firstOrNull;
      if (me != null && (me.host != _s.host || me.port != _s.port)) {
        await _storage.write(key: 'host', value: me.host);
        await _storage.write(key: 'port', value: '${me.port}');
        _set(_copy(host: me.host, port: me.port));
        _retry?.cancel();
        _connectLoop();
      }
    } else if (_s.autoPair && found.isNotEmpty && DateTime.now().isAfter(_noAskBefore)) {
      final err = await ask(found.first.host, found.first.port);
      if (err != null) {
        _noAskBefore = DateTime.now().add(Duration(minutes: err.contains('denied') ? 5 : 1));
      }
    }
  }

  @override
  Future<String?> pair(String host, int port, String code) => _handshake(host, port, code: code);

  @override
  Future<String?> ask(String host, int port) => _handshake(host, port);

  /// First-time pairing handshake. [code] == null means code-free (desktop user approves).
  Future<String?> _handshake(String host, int port, {String? code}) async {
    if (_pairing) return 'Already pairing';
    _pairing = true;
    _set(_copy(status: LinkStatus.connecting, lastError: null, sas: null));
    String? observedFp;
    final id = await _id();
    String? error;
    try {
      final ws = await _open(host, port, pinned: null, onFp: (f) => observedFp = f);
      final done = Completer<String?>();
      late StreamSubscription sub;
      sub = ws.listen((raw) async {
        final m = jsonDecode(raw as String) as Map<String, dynamic>;
        final p = m['payload'] as Map<String, dynamic>;
        switch (m['type']) {
          case 'auth.challenge':
            final nonce = p['nonce'] as String;
            if (code != null) {
              ws.add(jsonEncode(_frame(id, 'pair.request',
                  {'device': _device(id), 'pairingCodeProof': pairProof(code, nonce, id, observedFp!)})));
            } else {
              ws.add(jsonEncode(_frame(id, 'pair.ask', {'device': _device(id)})));
              _set(_copy(sas: sas(nonce, observedFp!)));
            }
          case 'pair.accept':
            final dev = p['device'] as Map;
            await _persist(host, port, observedFp!, p['authToken'] as String, dev['name'] as String, dev['deviceId'] as String);
            done.complete(null);
          case 'pair.reject':
            done.complete(_reason(p['reason'] as String));
        }
      }, onError: (e) {
        if (!done.isCompleted) done.complete('Connection error');
      }, onDone: () {
        if (!done.isCompleted) done.complete('Connection closed');
      });
      final timeout = code == null ? const Duration(seconds: 75) : const Duration(seconds: 15);
      error = await done.future.timeout(timeout, onTimeout: () => 'Timed out waiting for the desktop');
      await sub.cancel();
      await ws.close();
    } catch (e) {
      error = 'Could not reach $host:$port';
    } finally {
      _pairing = false;
    }
    if (error == null) {
      _set(_copy(sas: null, lastError: null));
      _connectLoop();
      return null;
    }
    _set(_copy(status: LinkStatus.unpaired, lastError: error, sas: null));
    return error;
  }

  String _reason(String r) => switch (r) {
        'bad_proof' => 'Wrong code',
        'expired' => 'Request expired. Try again',
        'locked' => 'Too many attempts. Start pairing again on the desktop',
        'revoked' => 'This phone was revoked on the desktop',
        'unknown_device' => 'This phone is no longer paired. Pair again',
        'denied' => 'The desktop denied the request',
        'busy' => 'The desktop is busy with other requests. Try again shortly',
        'forbidden' => 'The desktop only accepts pairing from your local network',
        _ => 'Rejected ($r)',
      };

  Future<void> _persist(String host, int port, String fp, String token, String name, String desktopId) async {
    await _storage.write(key: 'host', value: host);
    await _storage.write(key: 'port', value: '$port');
    await _storage.write(key: 'fp', value: fp);
    await _storage.write(key: 'token', value: token);
    await _storage.write(key: 'desktopName', value: name);
    await _storage.write(key: 'desktopId', value: desktopId);
    _token = token;
    _certFp = fp;
    _desktopId = desktopId;
    _set(_copy(host: host, port: port, desktopName: name));
  }

  Future<WebSocket> _open(String host, int port, {String? pinned, required void Function(String) onFp}) {
    final client = HttpClient()
      ..badCertificateCallback = (cert, h, p) {
        final fp = sha256.convert(cert.der).toString();
        onFp(fp);
        return pinned == null || fp == pinned; // first pairing: trust-on-first-use, bound by proof / SAS
      };
    return WebSocket.connect('wss://$host:$port', customClient: client).timeout(const Duration(seconds: 8));
  }

  Future<void> _connectLoop() async {
    if (_disposed || !_s.paired || _token == null || _pairing) return;
    final token = _token!, fp = _certFp!;
    _set(_copy(status: LinkStatus.connecting));
    final id = await _id();
    try {
      final ws = await _open(_s.host!, _s.port!, pinned: fp, onFp: (_) {});
      _ws = ws;
      ws.listen((raw) {
        final m = jsonDecode(raw as String) as Map<String, dynamic>;
        final pl = m['payload'] as Map<String, dynamic>;
        switch (m['type']) {
          case 'auth.challenge':
            ws.add(jsonEncode(_frame(id, 'auth.hello',
                {'device': _device(id), 'proof': authProof(token, pl['nonce'] as String, id)})));
          case 'auth.ok':
            final name = (pl['device'] as Map)['name'] as String;
            _storage.write(key: 'desktopName', value: name);
            _backoffSec = 1;
            _hb?.cancel();
            _hb = Timer.periodic(const Duration(seconds: 15), (_) => _send('heartbeat', {}));
            _set(_copy(status: LinkStatus.connected, desktopName: name, lastError: null));
          case 'pair.reject':
            final r = pl['reason'] as String;
            if (r == 'revoked' || r == 'unknown_device') {
              final msg = _reason(r);
              forget().then((_) => _set(_copy(status: LinkStatus.rejected, lastError: msg)));
            }
        }
      }, onDone: _onClosed, onError: (_) => _onClosed());
    } catch (_) {
      _onClosed();
    }
  }

  Future<void> _send(String type, Map<String, dynamic> payload) async {
    final ws = _ws;
    if (ws == null || _s.status != LinkStatus.connected) return;
    ws.add(jsonEncode(_frame(await _id(), type, payload)));
  }

  void _onClosed() {
    _hb?.cancel();
    _ws = null;
    if (_disposed || !_s.paired || _pairing) return;
    _set(_copy(status: LinkStatus.offline));
    _retry?.cancel();
    _retry = Timer(Duration(seconds: _backoffSec), _connectLoop);
    _backoffSec = min(_backoffSec * 2, 30);
  }

  @override
  Future<void> setDeviceName(String name) async {
    final n = name.trim();
    if (n.isEmpty || n.length > 80) return;
    await _storage.write(key: 'deviceName', value: n);
    _set(_copy(deviceName: n));
    await _send('device.rename', {'name': n});
  }

  @override
  Future<void> setAutoPair(bool on) async {
    await _storage.write(key: 'autoPair', value: on ? '1' : '0');
    _noAskBefore = DateTime.fromMillisecondsSinceEpoch(0);
    _set(_copy(autoPair: on));
    if (on && !_s.paired) unawaited(_scanOnce());
  }

  @override
  Future<void> forget() async {
    _retry?.cancel();
    _hb?.cancel();
    await _ws?.close();
    _ws = null;
    _token = _certFp = _desktopId = null;
    for (final k in ['host', 'port', 'fp', 'token', 'desktopName', 'desktopId']) {
      await _storage.delete(key: k);
    }
    // Don't instantly re-pair to the desktop the user just removed.
    _noAskBefore = DateTime.now().add(const Duration(minutes: 5));
    _set(_copy(status: LinkStatus.unpaired, desktopName: null, host: null, port: null, lastError: null));
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _hb?.cancel();
    _scan?.cancel();
    _ws?.close();
    super.dispose();
  }
}
