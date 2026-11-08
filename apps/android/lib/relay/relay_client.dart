import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'e2e.dart';

enum RelayStatus { off, connecting, online }

class RelayPeer {
  RelayPeer({required this.id, required this.name, required this.kind, required this.pub, this.appVersion = '0'});
  final String id; // SHA-256(pub) hex
  String name;
  final String kind; // windows | android
  final String pub;
  final String appVersion;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'kind': kind, 'pub': pub, 'appVersion': appVersion};
  factory RelayPeer.fromJson(Map j) =>
      RelayPeer(id: j['id'] as String, name: j['name'] as String, kind: j['kind'] as String, pub: j['pub'] as String, appVersion: (j['appVersion'] ?? '0') as String);
}

/// ws:// is only allowed to loopback/private hosts (tests, a home server). Everything else must be wss://.
bool validRelayUrl(String u) {
  final uri = Uri.tryParse(u);
  if (uri == null || uri.host.isEmpty) return false;
  if (uri.scheme == 'wss') return true;
  if (uri.scheme != 'ws') return false;
  return RegExp(r'^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)').hasMatch(uri.host);
}

class _PeerState {
  Session? session;
  HsState? pending;
  final List<({DateTime at, String frame})> queue = [];
  DateTime lastReset = DateTime.fromMillisecondsSinceEpoch(0);
}

/// Internet transport for the phone. Mirrors apps/desktop/src/main/relay/relayClient.ts (same wire protocol, verified
/// against it in test/relay_interop_test.dart). Connects OUT to the relay, so it works on mobile data behind carrier
/// NAT, keeps an end-to-end encrypted session with every paired device that is online, and can join a pairing by code.
class RelayClient {
  RelayClient({
    required this.identity,
    required this.self,
    required Iterable<RelayPeer> peers,
    this.onPeersChanged,
    this.onConnected,
    this.onDisconnected,
    this.onMessage,
    this.onStatus,
  }) {
    for (final p in peers) {
      _peers[p.id] = p;
    }
  }

  final Identity identity;
  final ({String name, String kind, String appVersion}) Function() self;
  void Function()? onPeersChanged;
  void Function(RelayPeer)? onConnected;
  void Function(String id)? onDisconnected;
  void Function(String from, Map<String, dynamic> envelope)? onMessage;
  void Function(RelayStatus)? onStatus;

  final Map<String, RelayPeer> _peers = {};
  final Map<String, _PeerState> _ps = {};
  final Set<String> _onlinePeers = {};
  WebSocket? _ws;
  String? _url;
  RelayStatus _status = RelayStatus.off;
  int _backoffMs = 1000;
  Timer? _retry;
  bool _stopped = true;
  Future<void> _chain = Future.value(); // frames are processed strictly in order (counters, handshakes)
  _Join? _joining;

  RelayStatus get status => _status;
  String? get url => _url;
  List<RelayPeer> get peers => _peers.values.toList();
  List<String> get onlinePeerIds => [for (final e in _ps.entries) if (e.value.session != null) e.key];

  void _setStatus(RelayStatus s) {
    if (s == _status) return;
    _status = s;
    onStatus?.call(s);
  }

  // ---- connection -----------------------------------------------------------------------------------------

  void setUrl(String? url) {
    final next = (url != null && url.isNotEmpty && validRelayUrl(url)) ? url : null;
    if (next == _url && !_stopped) return;
    _url = next;
    _teardown();
    _stopped = next == null;
    if (next == null) {
      _setStatus(RelayStatus.off);
    } else {
      _connect();
    }
  }

  void stop() {
    _stopped = true;
    _teardown();
    _setStatus(RelayStatus.off);
  }

  void _teardown() {
    _retry?.cancel();
    final ws = _ws;
    _ws = null;
    ws?.close();
    _dropAll();
    _onlinePeers.clear();
  }

  void _dropAll() {
    for (final e in _ps.entries) {
      if (e.value.session != null) onDisconnected?.call(e.key);
      e.value.session = null;
      e.value.pending = null;
    }
  }

  Future<void> _connect() async {
    if (_url == null || _stopped) return;
    _setStatus(RelayStatus.connecting);
    try {
      final ws = await WebSocket.connect(_url!).timeout(const Duration(seconds: 12));
      if (_stopped) {
        ws.close();
        return;
      }
      _ws = ws;
      ws.listen(
        (raw) {
          if (!identical(_ws, ws) || raw is! String) return;
          Map<String, dynamic> m;
          try {
            m = jsonDecode(raw) as Map<String, dynamic>;
          } catch (_) {
            return;
          }
          _chain = _chain.then((_) => _onRelay(m)).catchError((_) {});
        },
        onDone: () => _lost(ws),
        onError: (_) => _lost(ws),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleRetry();
    }
  }

  void _lost(WebSocket ws) {
    if (!identical(_ws, ws)) return;
    _ws = null;
    _dropAll();
    _onlinePeers.clear();
    _scheduleRetry();
  }

  void _scheduleRetry() {
    _setStatus(_stopped ? RelayStatus.off : RelayStatus.connecting);
    if (_stopped) return;
    _retry?.cancel();
    _retry = Timer(Duration(milliseconds: _backoffMs), _connect);
    _backoffMs = min(_backoffMs * 2, 30000);
  }

  void _tx(Map<String, dynamic> m) {
    final ws = _ws;
    if (ws != null && ws.readyState == WebSocket.open) ws.add(jsonEncode(m));
  }

  void _body(String to, Map<String, dynamic> b) => _tx({'t': 'send', 'to': to, 'body': jsonEncode(b)});

  RelayPeer? _trusted(String id) {
    final p = _peers[id];
    return (p != null && idOf(p.pub) == id) ? p : null;
  }

  _PeerState _state(String id) => _ps.putIfAbsent(id, () => _PeerState());

  // ---- relay frames ---------------------------------------------------------------------------------------

  Future<void> _onRelay(Map<String, dynamic> m) async {
    switch (m['t']) {
      case 'hello':
        _tx({'t': 'auth', 'pub': identity.pub, 'sig': await signText(identity, 'solo-relay-v1|${m['nonce']}')});
      case 'ready':
        _backoffMs = 1000;
        _setStatus(RelayStatus.online);
        refreshWatch();
      case 'presence':
        final id = m['id'] as String;
        if (m['online'] == true) {
          _onlinePeers.add(id);
          _ensureSession(id);
        } else {
          _peerGone(id);
        }
      case 'offline':
        _peerGone(m['to'] as String);
      case 'msg':
        await _onBody(m['from'] as String, m['body'] as String);
      case 'rdv.found':
        final j = _joining;
        if (j != null) {
          j.hostId = m['host'] as String;
          _sendPairReq(j);
        }
      case 'rdv.none':
        _finishJoin('Code not found or expired');
    }
  }

  /// Call after the peer list changes so presence is tracked for new peers.
  void refreshWatch() {
    if (_status != RelayStatus.online) return;
    final ids = _peers.keys.toList();
    if (ids.isNotEmpty) _tx({'t': 'watch', 'ids': ids});
  }

  void _peerGone(String id) {
    _onlinePeers.remove(id);
    final p = _ps[id];
    if (p?.session != null) onDisconnected?.call(id);
    p?.session = null;
    p?.pending = null;
  }

  // ---- sessions -------------------------------------------------------------------------------------------

  /// The device with the lower id always initiates, so two devices never handshake at the same time.
  Future<void> _ensureSession(String id) async {
    final peer = _trusted(id);
    if (peer == null || _status != RelayStatus.online) return;
    final p = _state(id);
    if (p.session != null || p.pending != null) return;
    if (identity.id.compareTo(id) < 0) {
      final h = await hsInitiate(identity, id);
      p.pending = h.state;
      final s = self();
      _body(id, {'k': 'hs1', ...h.msg, 'name': s.name, 'kind': s.kind});
    } else if (DateTime.now().difference(p.lastReset) > const Duration(seconds: 3)) {
      p.lastReset = DateTime.now();
      _body(id, {'k': 'reset'}); // ask the lower-id side to start
    }
  }

  Future<void> _established(String id, Session session) async {
    final p = _state(id);
    p.session = session;
    p.pending = null;
    onConnected?.call(_peers[id]!);
    final q = List.of(p.queue);
    p.queue.clear();
    for (final x in q) {
      if (DateTime.now().difference(x.at) < const Duration(seconds: 30)) {
        final f = await session.seal(x.frame);
        _body(id, {'k': 'data', 'c': f.c, 'ct': f.ct});
      }
    }
  }

  Future<void> _onBody(String from, String raw) async {
    Map<String, dynamic> m;
    try {
      m = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final k = m['k'];
    if (k == 'pair.ack') return _onPairAck(from, m);
    if (k == 'pair.no') {
      final r = m['reason'];
      return _finishJoin(r == 'bad_proof' ? 'Wrong code' : r == 'locked' ? 'Too many attempts. Start again on the other device' : 'Code expired');
    }

    final peer = _trusted(from);
    if (peer == null) return; // strangers are ignored entirely
    final p = _state(from);

    switch (k) {
      case 'hs1':
        if (p.pending != null && identity.id.compareTo(from) < 0) return; // we initiate; ignore their simultaneous attempt
        p.pending = null;
        final r = await hsRespond(identity, from, peer.pub, m);
        if (r == null) return;
        final s = self();
        _body(from, {'k': 'hs2', ...r.msg, 'name': s.name, 'kind': s.kind});
        final nm = m['name'];
        if (nm is String && nm.isNotEmpty && nm != peer.name) {
          peer.name = nm;
          onPeersChanged?.call();
        }
        if (p.session != null) onDisconnected?.call(from);
        await _established(from, r.session);
      case 'hs2':
        final st = p.pending;
        if (st == null) return;
        final sess = await hsFinish(identity, from, peer.pub, st, m);
        if (sess == null) {
          p.pending = null;
          return;
        }
        final nm = m['name'];
        if (nm is String && nm.isNotEmpty && nm != peer.name) {
          peer.name = nm;
          onPeersChanged?.call();
        }
        await _established(from, sess);
      case 'reset':
        if (p.pending != null) return; // a handshake in flight will finish; restarting would orphan the reply
        if (p.session != null) {
          p.session = null;
          onDisconnected?.call(from);
        }
        await _ensureSession(from);
      case 'data':
        final sess = p.session;
        final c = m['c'], ct = m['ct'];
        final pt = (sess != null && c is int && ct is String) ? await sess.open(c, ct) : null;
        if (pt == null) {
          if (DateTime.now().difference(p.lastReset) > const Duration(seconds: 3)) {
            p.lastReset = DateTime.now();
            _body(from, {'k': 'reset'});
          }
          return;
        }
        try {
          final env = jsonDecode(pt) as Map<String, dynamic>;
          if (env['from'] == from && env['v'] == 1) onMessage?.call(from, env);
        } catch (_) {}
    }
  }

  /// Returns false only if the peer is unknown. Queues briefly while a session is being established.
  Future<bool> send(String to, String type, Map<String, dynamic> payload) async {
    if (_trusted(to) == null || _status != RelayStatus.online) return false;
    final frame = jsonEncode({
      'v': 1,
      'id': '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 32)}',
      'ts': DateTime.now().millisecondsSinceEpoch,
      'from': identity.id,
      'type': type,
      'payload': payload,
    });
    final p = _state(to);
    final s = p.session;
    if (s != null) {
      final f = await s.seal(frame);
      _body(to, {'k': 'data', 'c': f.c, 'ct': f.ct});
      return true;
    }
    if (!_onlinePeers.contains(to)) return false; // nobody to deliver to; state is re-sent on the next connect
    if (p.queue.length < 64) p.queue.add((at: DateTime.now(), frame: frame));
    await _ensureSession(to);
    return true;
  }

  // ---- pairing by code (joiner side) --------------------------------------------------------------------

  /// Enter the 12-character code shown on the other device. Returns null on success, otherwise an error message.
  Future<String?> joinPairing(String codeInput) {
    if (_status != RelayStatus.online) return Future.value('Not connected to the relay');
    final code = normalizeCode(codeInput);
    if (code.length != 12) return Future.value('Enter the 12-character code');
    _finishJoin('Cancelled');
    final j = _Join(code, randomNonce());
    _joining = j;
    j.timer = Timer(const Duration(seconds: 20), () => _finishJoin('No answer from the other device'));
    _tx({'t': 'rdv.join', 'key': rendezvousKey(code)});
    return j.done.future;
  }

  void _finishJoin(String? error) {
    final j = _joining;
    if (j == null) return;
    _joining = null;
    j.timer?.cancel();
    if (!j.done.isCompleted) j.done.complete(error);
  }

  void _sendPairReq(_Join j) {
    final s = self();
    _body(j.hostId!, {
      'k': 'pair.req',
      'device': {'name': s.name, 'kind': s.kind, 'appVersion': s.appVersion},
      'pub': identity.pub,
      'nonce': j.nonce,
      // host key is unknown yet; the host id inside the proof binds it
      'proof': pairingProof(j.code, 'req', j.hostId!, identity.id, j.nonce, identity.pub, ''),
    });
  }

  void _onPairAck(String from, Map<String, dynamic> m) {
    final j = _joining;
    if (j == null || j.hostId != from) return;
    final pub = m['pub'] as String;
    final expect = pairingProof(j.code, 'ack', from, identity.id, j.nonce, identity.pub, pub);
    if (idOf(pub) != from || !safeEqual(expect, m['proof'] as String)) {
      return _finishJoin('The other device did not prove it knows the code');
    }
    final d = m['device'] as Map;
    addPeer(RelayPeer(id: from, name: d['name'] as String, kind: d['kind'] as String, pub: pub, appVersion: (d['appVersion'] ?? '0') as String));
    _finishJoin(null);
    _ensureSession(from);
  }

  // ---- peers ----------------------------------------------------------------------------------------------

  void addPeer(RelayPeer p) {
    _peers[p.id] = p;
    onPeersChanged?.call();
    refreshWatch();
  }

  void removePeer(String id) {
    _peers.remove(id);
    if (_ps[id]?.session != null) onDisconnected?.call(id);
    _ps.remove(id);
    _onlinePeers.remove(id);
    onPeersChanged?.call();
    refreshWatch();
  }
}

class _Join {
  _Join(this.code, this.nonce);
  final String code;
  final String nonce;
  String? hostId;
  Timer? timer;
  final done = Completer<String?>();
}
