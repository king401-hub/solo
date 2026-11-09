import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

/// Incremental SHA-256 (the file is never held in memory).
class ChunkedSha256 {
  ChunkedSha256() {
    _conv = sha256.startChunkedConversion(_sink);
  }
  final _sink = _Capture();
  late final ByteConversionSink _conv;
  String? _hex;

  void add(List<int> bytes) => _conv.add(bytes);

  String finish() {
    if (_hex == null) {
      _conv.close();
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

final _reserved = RegExp(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])$', caseSensitive: false);

/// A file name that is safe to create: no folders, no `..`, no control or reserved characters, not too long.
String safeName(String raw) {
  var n = raw.replaceAll('\\', '/').split('/').last;
  n = n.replaceAll(RegExp(r'[\u0000-\u001f<>:"/\\|?*]'), '_').replaceAll(RegExp(r'[. ]+$'), '').trim();
  if (n.isEmpty || n == '.' || n == '..') n = 'file';
  final dot = n.lastIndexOf('.');
  final ext = dot > 0 ? n.substring(dot) : '';
  final stem = dot > 0 ? n.substring(0, dot) : n;
  if (_reserved.hasMatch(stem)) n = '_$n';
  if (n.length > 150) n = n.substring(0, 150 - ext.length) + ext;
  return n;
}

/// `name`, then `name (1).ext`, `name (2).ext` ... so a received file never replaces an existing one.
String uniquePath(String dir, String name, [bool Function(String)? exists]) {
  final has = exists ?? (String p) => File(p).existsSync();
  final dot = name.lastIndexOf('.');
  final ext = dot > 0 ? name.substring(dot) : '';
  final stem = dot > 0 ? name.substring(0, dot) : name;
  var p = '$dir/$name';
  for (var i = 1; has(p); i++) {
    p = '$dir/$stem ($i)$ext';
  }
  return p;
}
