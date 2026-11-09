import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'file_sender.dart';
import 'file_util.dart';

/// A file that arrived from a computer and is stored inside the app.
class ReceivedInfo {
  const ReceivedInfo({required this.id, required this.name, required this.size, required this.at, required this.fromName, required this.path});
  final String id, name, fromName, path;
  final int size, at;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'size': size, 'at': at, 'fromName': fromName, 'path': path};
  factory ReceivedInfo.fromJson(Map j) => ReceivedInfo(
      id: j['id'] as String, name: j['name'] as String, size: (j['size'] as num).toInt(), at: (j['at'] as num).toInt(), fromName: j['fromName'] as String, path: j['path'] as String);
}

class _In {
  _In(this.from, this.name, this.size, this.part, this.raf, this.fromName);
  final String from, name, part, fromName;
  final int size;
  final RandomAccessFile raf;
  final hash = ChunkedSha256();
  int received = 0, next = 0;
  bool ended = false;
  DateTime lastAt = DateTime.now();
}

/// Receives files from paired computers (the mirror of the desktop Inbox). Same rules: one folder, safe names, never
/// replaces an existing file, a file appears under its real name only once its size and SHA-256 match, partial files
/// are deleted on error, cancel or silence.
class FileReceiver {
  FileReceiver({
    required this.dir,
    required this.send,
    required this.onChange,
    this.peerName = _defaultName,
    this.maxBytes = maxFileBytes,
    this.idleTimeout = const Duration(seconds: 60),
  }) {
    try {
      Directory(dir).createSync(recursive: true);
      final f = File('$dir/.index.json');
      if (f.existsSync()) {
        _list = [for (final j in jsonDecode(f.readAsStringSync()) as List) ReceivedInfo.fromJson(j as Map)].take(_keep).toList();
      }
    } catch (_) {
      _list = [];
    }
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => sweep());
  }

  static String _defaultName(String id) => 'your computer';
  static const _maxActive = 4;
  static const _keep = 50;

  final String dir;
  final Future<bool> Function(String peerId, String type, Map<String, dynamic> payload) send;
  final void Function() onChange;
  final String Function(String peerId) peerName;
  final int maxBytes;
  final Duration idleTimeout;

  final _active = <String, _In>{};
  List<ReceivedInfo> _list = [];
  Timer? _timer;

  List<ReceivedInfo> get received => [for (final f in _list) if (File(f.path).existsSync()) f];

  /// Files arriving right now, as progress rows for the UI.
  List<TransferInfo> get receiving => [
        for (final e in _active.entries)
          TransferInfo(
              id: e.key.split(':').last, name: e.value.name, size: e.value.size, peerId: e.value.from, peerName: e.value.fromName,
              sent: e.value.received, status: TransferStatus.sending),
      ];

  void _save() {
    try {
      File('$dir/.index.json').writeAsStringSync(jsonEncode([for (final f in _list.take(_keep)) f.toJson()]));
    } catch (_) {}
  }

  void delete(String id) {
    for (final f in _list.where((f) => f.id == id)) {
      try {
        File(f.path).deleteSync();
      } catch (_) {}
    }
    _list = _list.where((f) => f.id != id).toList();
    _save();
    onChange();
  }

  String _key(String from, String tid) => '$from:$tid';

  void _drop(String key) {
    final t = _active.remove(key);
    if (t == null) return;
    try {
      t.raf.closeSync();
    } catch (_) {}
    try {
      File(t.part).deleteSync();
    } catch (_) {}
    onChange();
  }

  void sweep() {
    final now = DateTime.now();
    for (final k in _active.keys.toList()) {
      if (now.difference(_active[k]!.lastAt) > idleTimeout) _drop(k);
    }
  }

  void dispose() {
    _timer?.cancel();
    for (final k in _active.keys.toList()) {
      _drop(k);
    }
  }

  /// A device went offline: whatever it was sending will not finish.
  void peerLost(String id) {
    for (final k in _active.keys.where((k) => k.startsWith('$id:')).toList()) {
      _drop(k);
    }
  }

  /// Handle one message from a paired device. Returns true if it was a file message for the receiving side.
  bool handle(String from, String type, Map<String, dynamic> p) {
    switch (type) {
      case 'file.offer':
        _offer(from, p);
        return true;
      case 'file.chunk':
        _chunk(from, p);
        return true;
      case 'file.end':
        _end(from, p);
        return true;
      case 'file.cancel':
        final k = _key(from, '${p['transferId']}');
        if (!_active.containsKey(k)) return false;
        _drop(k);
        return true;
    }
    return false;
  }

  void _reply(String to, String tid, bool ok, [String? reason]) {
    unawaited(send(to, 'file.reply', {'transferId': tid, 'ok': ok, 'reason': ?reason}));
  }

  void _offer(String from, Map<String, dynamic> p) {
    final tid = p['transferId'] as String;
    final size = (p['size'] as num).toInt();
    final key = _key(from, tid);
    if (_active.containsKey(key)) return _reply(from, tid, false, 'Already receiving this file');
    if (size > maxBytes) return _reply(from, tid, false, 'That file is too large (limit 2 GB)');
    if (_active.length >= _maxActive) return _reply(from, tid, false, 'Busy receiving other files, try again in a moment');
    final part = '$dir/.part-${Random.secure().nextInt(1 << 32).toRadixString(16)}-$tid';
    RandomAccessFile raf;
    try {
      Directory(dir).createSync(recursive: true);
      raf = File(part).openSync(mode: FileMode.writeOnly);
    } catch (_) {
      return _reply(from, tid, false, 'The phone could not create the file (is its storage full?)');
    }
    _active[key] = _In(from, safeName('${p['name']}'), size, part, raf, peerName(from));
    onChange();
    _reply(from, tid, true);
  }

  void _chunk(String from, Map<String, dynamic> p) {
    final tid = p['transferId'] as String;
    final key = _key(from, tid);
    final t = _active[key];
    if (t == null || t.ended) return;
    void cancel(String why) {
      unawaited(send(from, 'file.cancel', {'transferId': tid, 'reason': why}));
      _drop(key);
    }

    final seq = (p['seq'] as num).toInt();
    if (seq != t.next) return cancel('Chunks arrived out of order');
    final Uint8List buf;
    try {
      buf = base64Decode(p['data'] as String);
    } catch (_) {
      return cancel('A chunk was damaged');
    }
    if (t.received + buf.length > t.size) return cancel('More data than announced');
    try {
      t.raf.writeFromSync(buf);
    } catch (_) {
      return cancel('The phone could not write the file (storage full?)');
    }
    t.hash.add(buf);
    t.received += buf.length;
    t.next++;
    t.lastAt = DateTime.now();
    unawaited(send(from, 'file.ack', {'transferId': tid, 'seq': seq}));
    if (seq % 8 == 0) onChange();
  }

  void _end(String from, Map<String, dynamic> p) {
    final tid = p['transferId'] as String;
    final key = _key(from, tid);
    final t = _active[key];
    if (t == null) return;
    void fail(String why) {
      unawaited(send(from, 'file.result', {'transferId': tid, 'ok': false, 'reason': why}));
      _drop(key);
    }

    t.ended = true;
    if (t.received != t.size) return fail('The file arrived incomplete');
    if (t.hash.finish() != p['sha256']) return fail('The file was damaged in transit (checksum mismatch)');
    try {
      t.raf.closeSync();
    } catch (_) {}
    final fin = uniquePath(dir, t.name);
    try {
      File(t.part).renameSync(fin);
    } catch (_) {
      return fail('The phone could not save the file');
    }
    _active.remove(key);
    _list.insert(0, ReceivedInfo(id: tid, name: fin.split('/').last, size: t.size, at: DateTime.now().millisecondsSinceEpoch, fromName: t.fromName, path: fin));
    if (_list.length > _keep) _list = _list.take(_keep).toList();
    _save();
    unawaited(send(from, 'file.result', {'transferId': tid, 'ok': true}));
    onChange();
  }
}
