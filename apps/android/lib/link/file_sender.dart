import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

const fileChunkBytes = 48 * 1024;
const fileWindow = 8;
const maxFileBytes = 2 * 1024 * 1024 * 1024;

enum TransferStatus { waiting, sending, finishing, done, failed, cancelled }

/// What the UI shows for one file being sent.
class TransferInfo {
  const TransferInfo({required this.id, required this.name, required this.size, required this.peerId, required this.peerName, this.sent = 0, this.status = TransferStatus.waiting, this.error});
  final String id, name, peerId, peerName;
  final int size, sent;
  final TransferStatus status;
  final String? error;

  bool get active => status == TransferStatus.waiting || status == TransferStatus.sending || status == TransferStatus.finishing;
  double get progress => size == 0 ? (status == TransferStatus.done ? 1 : 0) : (sent / size).clamp(0, 1).toDouble();

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'size': size, 'peerId': peerId, 'peerName': peerName, 'sent': sent, 'status': status.index, 'error': error};
  factory TransferInfo.fromJson(Map j) => TransferInfo(
        id: j['id'] as String, name: j['name'] as String, size: j['size'] as int, peerId: j['peerId'] as String, peerName: j['peerName'] as String,
        sent: j['sent'] as int, status: TransferStatus.values[j['status'] as int], error: j['error'] as String?);
}

class _Out {
  _Out(this.info, this.file);
  TransferInfo info;
  final RandomAccessFile file;
  final digest = _Digest();
  int nextSeq = 0, acked = 0, offset = 0;
  bool eof = false, endSent = false, pumping = false;
  DateTime lastProgress = DateTime.now();
}

class _Digest {
  final _sink = _Capture();
  late final ByteConversionSink conv = sha256.startChunkedConversion(_sink);
  String? _hex;
  void add(List<int> b) => conv.add(b);
  String finish() {
    if (_hex == null) {
      conv.close();
      _hex = _sink.value.toString();
    }
    return _hex!;
  }
}

class _Capture implements Sink<Digest> {
  Digest? value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}

/// Sends files to a paired device over the encrypted link (LAN or relay), following the file.* protocol in
/// packages/shared/src/protocol.ts. At most [fileWindow] chunks are in flight, so a slow relay does not stall on every chunk.
class FileSender {
  FileSender({required this.send, required this.onChange, this.peerName = _defaultName, this.idleTimeout = const Duration(seconds: 45)});

  /// Delivers one message to a device. Returns false if it could not be sent (offline).
  final Future<bool> Function(String peerId, String type, Map<String, dynamic> payload) send;
  final void Function() onChange;
  final String Function(String peerId) peerName;
  final Duration idleTimeout;
  static String _defaultName(String id) => 'your computer';

  final _out = <String, _Out>{};
  final _history = <TransferInfo>[];
  Timer? _watchdog;

  List<TransferInfo> get transfers => [..._out.values.map((o) => o.info), ..._history];

  static String _newId() {
    final r = Random.secure();
    return List.generate(24, (_) => 'abcdefghijklmnopqrstuvwxyz0123456789'[r.nextInt(36)]).join();
  }

  void _set(_Out o, {int? sent, TransferStatus? status, String? error}) {
    o.info = TransferInfo(
        id: o.info.id, name: o.info.name, size: o.info.size, peerId: o.info.peerId, peerName: o.info.peerName,
        sent: sent ?? o.info.sent, status: status ?? o.info.status, error: error ?? o.info.error);
    onChange();
  }

  void _finish(_Out o, TransferStatus status, [String? error]) {
    _set(o, status: status, error: error);
    _out.remove(o.info.id);
    try {
      o.file.closeSync();
    } catch (_) {}
    _history.insert(0, o.info);
    if (_history.length > 20) _history.removeLast();
    if (_out.isEmpty) {
      _watchdog?.cancel();
      _watchdog = null;
    }
    onChange();
  }

  /// Starts sending [path] to [peerId]. Returns the transfer id, or null with the reason in [lastRefusal].
  String? lastRefusal;
  Future<String?> sendFile(String peerId, String path, String name) async {
    lastRefusal = null;
    final f = File(path);
    if (!f.existsSync()) {
      lastRefusal = 'That file could not be found.';
      return null;
    }
    final size = f.lengthSync();
    if (size > maxFileBytes) {
      lastRefusal = 'That file is larger than 2 GB.';
      return null;
    }
    final id = _newId();
    final raf = await f.open();
    final o = _Out(TransferInfo(id: id, name: name, size: size, peerId: peerId, peerName: peerName(peerId)), raf);
    _out[id] = o;
    _watchdog ??= Timer.periodic(const Duration(seconds: 5), (_) => _check());
    onChange();
    final ok = await send(peerId, 'file.offer', {'transferId': id, 'name': name, 'size': size});
    if (!ok) _finish(o, TransferStatus.failed, '${o.info.peerName} is not reachable right now. Check that Solo is running on it.');
    return id;
  }

  void cancel(String id) {
    final o = _out[id];
    if (o == null) return;
    send(o.info.peerId, 'file.cancel', {'transferId': id});
    _finish(o, TransferStatus.cancelled);
  }

  void clearFinished() {
    _history.clear();
    onChange();
  }

  /// A device went offline: fail everything headed there so the UI does not wait forever.
  void peerLost(String peerId) {
    for (final o in _out.values.where((o) => o.info.peerId == peerId).toList()) {
      _finish(o, TransferStatus.failed, '${o.info.peerName} went offline. Send the file again when it is back.');
    }
  }

  void _check() {
    final now = DateTime.now();
    for (final o in _out.values.toList()) {
      if (now.difference(o.lastProgress) > idleTimeout) {
        send(o.info.peerId, 'file.cancel', {'transferId': o.info.id});
        _finish(o, TransferStatus.failed, 'No answer from ${o.info.peerName}. Make sure Solo is running on it, then try again.');
      }
    }
  }

  /// Feed every received message here. Returns true if it was a file message.
  bool handle(String from, String type, Map<String, dynamic> p) {
    if (!type.startsWith('file.')) return false;
    final o = _out[p['transferId']];
    if (o == null || o.info.peerId != from) return true;
    o.lastProgress = DateTime.now();
    switch (type) {
      case 'file.reply':
        if (p['ok'] == true) {
          _set(o, status: TransferStatus.sending);
          unawaited(_pump(o));
        } else {
          _finish(o, TransferStatus.failed, (p['reason'] as String?) ?? '${o.info.peerName} refused the file.');
        }
      case 'file.ack':
        o.acked = max(o.acked, (p['seq'] as int) + 1);
        unawaited(_pump(o));
      case 'file.result':
        if (p['ok'] == true) {
          _set(o, sent: o.info.size);
          _finish(o, TransferStatus.done);
        } else {
          _finish(o, TransferStatus.failed, (p['reason'] as String?) ?? 'The file did not arrive correctly.');
        }
      case 'file.cancel':
        _finish(o, TransferStatus.failed, (p['reason'] as String?) ?? '${o.info.peerName} cancelled the transfer.');
    }
    return true;
  }

  Future<void> _pump(_Out o) async {
    if (o.pumping || !_out.containsKey(o.info.id)) return;
    o.pumping = true;
    try {
      while (_out.containsKey(o.info.id) && !o.eof && o.nextSeq - o.acked < fileWindow) {
        final buf = await o.file.read(fileChunkBytes);
        if (!_out.containsKey(o.info.id)) return;
        if (buf.isEmpty) {
          o.eof = true;
          break;
        }
        o.digest.add(buf);
        o.offset += buf.length;
        final seq = o.nextSeq++;
        final ok = await send(o.info.peerId, 'file.chunk', {'transferId': o.info.id, 'seq': seq, 'data': base64Encode(buf)});
        if (!ok) {
          _finish(o, TransferStatus.failed, '${o.info.peerName} went offline. Send the file again when it is back.');
          return;
        }
        _set(o, sent: min(o.offset, o.info.size));
      }
      if (_out.containsKey(o.info.id) && o.eof && !o.endSent && o.acked >= o.nextSeq) {
        o.endSent = true;
        _set(o, status: TransferStatus.finishing);
        final ok = await send(o.info.peerId, 'file.end', {'transferId': o.info.id, 'sha256': o.digest.finish()});
        if (!ok && _out.containsKey(o.info.id)) _finish(o, TransferStatus.failed, '${o.info.peerName} went offline before confirming.');
      }
    } catch (e) {
      if (_out.containsKey(o.info.id)) _finish(o, TransferStatus.failed, 'Could not read the file: $e');
    } finally {
      o.pumping = false;
    }
  }

  void dispose() {
    _watchdog?.cancel();
    for (final o in _out.values.toList()) {
      _finish(o, TransferStatus.cancelled);
    }
  }
}
