import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../relay/e2e.dart' as e2e;
import '../relay/relay_client.dart';
import 'discovery.dart';
import 'file_receiver.dart';
import 'file_sender.dart';
import 'link_api.dart';
import '../sync/sync_store.dart';
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
  LinkClient({FlutterSecureStorage? storage, this.autoDiscover = false, this.incomingDir})
      : _storage = storage ?? const FlutterSecureStorage();

  /// Where files from computers are stored. Normally told to us by the native side (the app's private files folder).
  final String? incomingDir;
  FileReceiver? _receiver;
  final FlutterSecureStorage _storage;
  final bool autoDiscover;

  LinkState _s = const LinkState();
  @override
  LinkState get state => _s;
  void _set(LinkState s) {
    _s = _withRelay(s);
    notifyListeners();
  }

  /// Attach live peer/relay info (kept out of _copy so every state change stays fresh automatically).
  LinkState _withRelay(LinkState s) {
    final r = _relay;
    final lanOn = s.status == LinkStatus.connected && _desktopId != null;
    final online = r?.onlinePeerIds.toSet() ?? const <String>{};
    return LinkState(
      status: s.status, lastError: s.lastError, desktopName: s.desktopName, host: s.host, port: s.port,
      deviceName: s.deviceName, sas: s.sas, autoPair: s.autoPair, discovered: s.discovered, settings: s.settings,
      lastSync: s.lastSync,
      peers: [
        for (final p in r?.peers ?? const <RelayPeer>[])
          PeerInfo(
            id: p.id, name: p.name, kind: p.kind,
            online: online.contains(p.id) || (lanOn && p.id == _desktopId),
            via: (lanOn && p.id == _desktopId) ? 'lan' : online.contains(p.id) ? 'relay' : null,
          ),
      ],
      relayUrl: r?.url,
      relayStatus: r?.status.name ?? 'off',
      transfers: _files.transfers,
      receiving: _receiver?.receiving ?? const [],
      received: _receiver?.received ?? const [],
    );
  }

  late final FileSender _files = FileSender(
    send: _sendTo,
    onChange: () => _set(_s),
    peerName: (id) {
      for (final p in _s.peers) {
        if (p.id == id) return p.name;
      }
      return id == _desktopId ? (_s.desktopName ?? 'your computer') : 'your computer';
    },
  );

  /// Delivers to one device: over the LAN link when it is the connected desktop, otherwise through the relay.
  Future<bool> _sendTo(String peerId, String type, Map<String, dynamic> payload) async {
    final ws = _ws;
    if (peerId == _desktopId && ws != null && _s.status == LinkStatus.connected) {
      ws.add(jsonEncode(_frame(await _id(), type, payload)));
      return true;
    }
    return await _relay?.send(peerId, type, payload) ?? false;
  }

  @override
  Future<String?> sendFile(String peerId, String path, String name) async {
    await _files.sendFile(peerId, path, name);
    return _files.lastRefusal;
  }

  @override
  Future<void> cancelTransfer(String id) async => _files.cancel(id);
  @override
  Future<void> clearTransfers() async => _files.clearFinished();
  @override
  Future<void> deleteReceived(String id) async => _receiver?.delete(id);

  Future<String> _incomingPath() async {
    if (incomingDir != null) return incomingDir!;
    try {
      final p = await SharedPreferences.getInstance();
      final fromNative = p.getString('solo_incoming_dir');
      if (fromNative != null && fromNative.isNotEmpty) return fromNative;
    } catch (_) {}
    return '${Directory.systemTemp.parent.path}/files/incoming';
  }

  /// One entry point for every incoming file.* message, from the LAN link or the relay.
  void _onFileMessage(String from, String type, Map<String, dynamic> payload) {
    if (_files.handle(from, type, payload)) return; // replies, acks, results for files we are sending
    _receiver?.handle(from, type, payload);
  }

  // Secrets / identity (not part of LinkState).
  String? _token, _certFp, _desktopId, _deviceId;
  e2e.Identity? _identity;
  RelayClient? _relay;
  String? _applyingFrom; // device whose delta we are applying, so it is not echoed back to it
  SyncStore? _sync;
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
    Map<String, dynamic>? settings,
    int? lastSync,
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
        settings: settings ?? _s.settings,
        lastSync: lastSync ?? _s.lastSync,
      );
  static const _keep = Object();

  static List<RelayPeer> _loadPeers(String? json) {
    if (json == null) return const [];
    try {
      return [for (final p in jsonDecode(json) as List) RelayPeer.fromJson(p as Map)];
    } catch (_) {
      return const [];
    }
  }

  /// Send a change to every reachable device except the one it came from. The LAN desktop is reached over the LAN
  /// when connected (faster), everyone else through the relay. Because remote changes are forwarded too, a phone
  /// paired with several laptops keeps all of them in step.
  void _broadcast(SyncDelta d) {
    final lanId = _s.status == LinkStatus.connected ? _desktopId : null;
    if (lanId != null && lanId != _applyingFrom) _send('sync.delta', d.toPayload());
    final relay = _relay;
    if (relay == null) return;
    for (final id in relay.onlinePeerIds) {
      if (id != _applyingFrom && id != lanId) relay.send(id, 'sync.delta', d.toPayload());
    }
  }

  /// Hands the synced voice settings to the native wake-word service (it reads Flutter's SharedPreferences file),
  /// so desktop changes reach it even while the app UI is closed.
  Future<void> _publishVoiceConfig(Map<String, dynamic>? cfg) async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString('solo_voice_config', jsonEncode(cfg ?? const {}));
    } catch (_) {
      // best effort: the service falls back to defaults
    }
  }

  /// The device identity is an Ed25519 key kept in secure storage; the device id is the SHA-256 of its public key.
  Future<String> _id() async {
    if (_deviceId != null) return _deviceId!;
    var seed = await _storage.read(key: 'idSeed');
    if (seed == null) {
      final fresh = await e2e.generateIdentity();
      seed = fresh.seed;
      await _storage.write(key: 'idSeed', value: seed);
    }
    _identity = await e2e.identityFromSeed(seed);
    return _deviceId = _identity!.id;
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
      {'deviceId': id, 'kind': 'android', 'name': _s.deviceName, 'appVersion': appVersion, 'pub': _identity?.pub};

  /// Load saved settings/pairing, connect, and start looking for desktops if unpaired.
  Future<void> start() async {
    final name = await _storage.read(key: 'deviceName');
    final auto = await _storage.read(key: 'autoPair') == '1';
    _receiver = FileReceiver(
      dir: await _incomingPath(),
      send: _sendTo,
      onChange: () => _set(_s),
      peerName: (id) {
        for (final p in _s.peers) {
          if (p.id == id) return p.name;
        }
        return id == _desktopId ? (_s.desktopName ?? 'your computer') : 'your computer';
      },
    );
    final sync = SyncStore(await _id(), initial: SyncStore.parse(await _storage.read(key: 'sync')));
    _sync = sync;
    _relay = RelayClient(
      identity: _identity!,
      self: () => (name: _s.deviceName, kind: 'android', appVersion: appVersion),
      peers: _loadPeers(await _storage.read(key: 'relayPeers')),
      onPeersChanged: () {
        _storage.write(key: 'relayPeers', value: jsonEncode(_relay!.peers.map((p) => p.toJson()).toList()));
        _set(_s);
      },
      onStatus: (_) => _set(_s),
      onDisconnected: (id) {
        _files.peerLost(id);
        _receiver?.peerLost(id);
        _set(_s);
      },
      onConnected: (peer) {
        // exchange full state with the device that just came online; last-writer-wins makes both converge
        for (final d in sync.all()) {
          _relay!.send(peer.id, 'sync.delta', d.toPayload());
        }
        _set(_copy(lastSync: DateTime.now().millisecondsSinceEpoch));
      },
      onMessage: (from, env) {
        if ((env['type'] as String).startsWith('file.')) {
          _onFileMessage(from, env['type'] as String, Map<String, dynamic>.from(env['payload'] as Map));
          return;
        }
        if (env['type'] != 'sync.delta') return;
        final d = SyncDelta.fromPayload(env['payload']);
        if (d == null) return;
        _applyingFrom = from;
        try {
          sync.apply(d);
        } finally {
          _applyingFrom = null;
        }
      },
    );
    sync.onChange((d, local) {
      _storage.write(key: 'sync', value: sync.toJsonString());
      _broadcast(d);
      if (d.table == 'settings' && d.rowId == 'relay') {
        final u = d.deleted ? null : d.data?['url'];
        _relay?.setUrl(u is String ? u : null);
      }
      if (d.table == 'settings' && d.rowId == 'voice') {
        _publishVoiceConfig(sync.get('settings', 'voice'));
        _set(_copy(settings: sync.get('settings', 'voice') ?? const {}, lastSync: DateTime.now().millisecondsSinceEpoch));
      }
    });
    _publishVoiceConfig(sync.get('settings', 'voice'));
    _set(_copy(deviceName: name ?? _s.deviceName, autoPair: auto, settings: sync.get('settings', 'voice') ?? const {}));
    final savedRelay = sync.get('settings', 'relay')?['url'];
    _relay!.setUrl(savedRelay is String ? savedRelay : null);
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
            // The LAN pairing (TLS-pinned, code or approval) also gives us the desktop's key, so it is reachable over the
            // internet later without pairing again.
            final dpub = dev['pub'];
            if (dpub is String && e2e.idOf(dpub) == dev['deviceId']) {
              _relay?.addPeer(RelayPeer(id: dev['deviceId'] as String, name: dev['name'] as String, kind: 'windows', pub: dpub));
            }
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
            // Exchange full state; last-writer-wins on both sides makes them converge.
            for (final d in _sync?.all() ?? const <SyncDelta>[]) {
              _send('sync.delta', d.toPayload());
            }
            _set(_copy(lastSync: DateTime.now().millisecondsSinceEpoch));
          case 'sync.delta':
            final d = SyncDelta.fromPayload(pl);
            if (d != null) {
              _applyingFrom = _desktopId;
              try {
                _sync?.apply(d);
              } finally {
                _applyingFrom = null;
              }
            }
          case 'file.reply' || 'file.ack' || 'file.result' || 'file.cancel' || 'file.offer' || 'file.chunk' || 'file.end':
            if (_desktopId != null) _onFileMessage(_desktopId!, m['type'] as String, pl);
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
    if (_desktopId != null) {
      _files.peerLost(_desktopId!);
      _receiver?.peerLost(_desktopId!);
    }
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
  Future<void> setAssistantSetting(String key, Object value) async {
    final sync = _sync;
    if (sync == null) return;
    final cur = Map<String, dynamic>.from(sync.get('settings', 'voice') ?? const {});
    cur[key] = value;
    sync.set('settings', 'voice', cur);
  }

  @override
  Future<String?> setRelayUrl(String url) async {
    final u = url.trim().replaceAll(RegExp(r'/+$'), '');
    if (u.isNotEmpty && !validRelayUrl(u)) return 'Use a wss:// address (for example wss://your-relay.fly.dev)';
    _sync?.set('settings', 'relay', {'url': u}); // shared with every paired device
    return null;
  }

  @override
  Future<String?> pairRemote(String code) async {
    final r = _relay;
    if (r == null) return 'Not ready yet';
    final err = await r.joinPairing(code);
    _set(_s);
    return err;
  }

  @override
  Future<void> removePeer(String id) async {
    _relay?.removePeer(id);
    if (id == _desktopId) await forget();
    _set(_s);
  }

  @override
  Future<void> forget() async {
    _retry?.cancel();
    _hb?.cancel();
    await _ws?.close();
    _ws = null;
    final oldDesktop = _desktopId;
    if (oldDesktop != null) _relay?.removePeer(oldDesktop);
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
    _relay?.stop();
    _files.dispose();
    _receiver?.dispose();
    super.dispose();
  }
}
