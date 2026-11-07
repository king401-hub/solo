import 'dart:convert';
import 'dart:math';

/// Dart mirror of packages/shared/src/sync.ts (last-writer-wins with a hybrid clock).
/// Keep the semantics identical; the same cases are tested in test/sync_test.dart.
class SyncRow {
  SyncRow(this.updatedAt, this.by, this.deleted, this.data);
  final int updatedAt;
  final String by;
  final bool deleted;
  final Map<String, dynamic>? data;

  Map<String, dynamic> toJson() => {'updatedAt': updatedAt, 'by': by, 'deleted': deleted, 'data': data};
  factory SyncRow.fromJson(Map j) => SyncRow(
        j['updatedAt'] as int,
        j['by'] as String,
        j['deleted'] as bool,
        j['data'] == null ? null : Map<String, dynamic>.from(j['data'] as Map),
      );
}

class SyncDelta {
  SyncDelta(this.table, this.rowId, this.updatedAt, this.by, this.deleted, this.data);
  final String table;
  final String rowId;
  final int updatedAt;
  final String by;
  final bool deleted;
  final Map<String, dynamic>? data;

  Map<String, dynamic> toPayload() => {
        'table': table,
        'rowId': rowId,
        'updatedAt': updatedAt,
        'by': by,
        'deleted': deleted,
        if (data != null) 'data': data,
      };

  /// Returns null if the payload is malformed (never throws on untrusted input).
  static SyncDelta? fromPayload(Object? p) {
    if (p is! Map) return null;
    final table = p['table'], rowId = p['rowId'], at = p['updatedAt'], by = p['by'], del = p['deleted'];
    const tables = {'settings', 'memories', 'tasks', 'conversations'};
    if (table is! String || !tables.contains(table) || rowId is! String || at is! int || by is! String || del is! bool) {
      return null;
    }
    final data = p['data'];
    return SyncDelta(table, rowId, at, by, del, data is Map ? Map<String, dynamic>.from(data) : null);
  }
}

bool wins(int updatedAt, String by, SyncRow? existing) {
  if (existing == null) return true;
  if (updatedAt != existing.updatedAt) return updatedAt > existing.updatedAt;
  return by.compareTo(existing.by) > 0;
}

class SyncStore {
  SyncStore(this.deviceId, {Map<String, Map<String, SyncRow>>? initial, int Function()? now})
      : _tables = initial ?? {},
        _now = now ?? (() => DateTime.now().millisecondsSinceEpoch) {
    for (final rows in _tables.values) {
      for (final r in rows.values) {
        _clock = max(_clock, r.updatedAt);
      }
    }
  }

  final String deviceId;
  final int Function() _now;
  final Map<String, Map<String, SyncRow>> _tables;
  int _clock = 0;
  final _listeners = <void Function(SyncDelta d, bool local)>[];

  void onChange(void Function(SyncDelta d, bool local) f) => _listeners.add(f);

  int _stamp() => _clock = max(_now(), _clock + 1);

  SyncDelta _put(SyncDelta d, bool local) {
    (_tables[d.table] ??= {})[d.rowId] = SyncRow(d.updatedAt, d.by, d.deleted, d.deleted ? null : d.data);
    for (final f in List.of(_listeners)) {
      f(d, local);
    }
    return d;
  }

  SyncDelta set(String table, String rowId, Map<String, dynamic> data) =>
      _put(SyncDelta(table, rowId, _stamp(), deviceId, false, data), true);

  SyncDelta remove(String table, String rowId) => _put(SyncDelta(table, rowId, _stamp(), deviceId, true, null), true);

  bool apply(SyncDelta d) {
    _clock = max(_clock, d.updatedAt);
    if (!wins(d.updatedAt, d.by, _tables[d.table]?[d.rowId])) return false;
    _put(d, false);
    return true;
  }

  Map<String, dynamic>? get(String table, String rowId) {
    final r = _tables[table]?[rowId];
    return r != null && !r.deleted ? r.data : null;
  }

  List<SyncDelta> all() => [
        for (final t in _tables.entries)
          for (final r in t.value.entries)
            SyncDelta(t.key, r.key, r.value.updatedAt, r.value.by, r.value.deleted, r.value.data),
      ];

  String toJsonString() => jsonEncode(_tables.map((t, rows) => MapEntry(t, rows.map((id, r) => MapEntry(id, r.toJson())))));

  static Map<String, Map<String, SyncRow>> parse(String? s) {
    if (s == null) return {};
    try {
      final j = jsonDecode(s) as Map;
      return {
        for (final t in j.entries)
          t.key as String: {for (final r in (t.value as Map).entries) r.key as String: SyncRow.fromJson(r.value as Map)}
      };
    } catch (_) {
      return {}; // corrupt: start empty, the desktop repopulates on connect
    }
  }
}
