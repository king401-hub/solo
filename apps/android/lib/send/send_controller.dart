import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../link/link_api.dart';

class StagedFile {
  const StagedFile(this.path, this.name, this.size);
  final String path, name;
  final int size;
}

/// What the Send screen does: choose files (or receive them from the Android Share menu), send them to a paired
/// computer, clean up the temporary copies afterwards. The copies live in the app's cache and are deleted when done.
class SendController extends ChangeNotifier {
  SendController(this.link, [MethodChannel? channel]) : _c = channel ?? const MethodChannel('solo/wake');
  final LinkApi link;
  final MethodChannel _c;

  final pending = <StagedFile>[]; // chosen but not yet sent (waiting for a destination)
  final _staged = <String>{}; // temporary copies to delete once nothing is being sent
  String? message;
  String? target; // chosen computer when several are online

  List<PeerInfo> get computers => [for (final p in link.state.peers) if (p.kind == 'windows') p];
  List<PeerInfo> get onlineComputers => [for (final p in computers) if (p.online) p];

  /// The computer to send to: the one chosen, else the only one online.
  PeerInfo? get destination {
    final on = onlineComputers;
    for (final p in on) {
      if (p.id == target) return p;
    }
    return on.length == 1 ? on.first : null;
  }

  List<StagedFile> _parse(Object? raw) => [
        for (final m in (raw as List? ?? const []))
          StagedFile((m as Map)['path'] as String, m['name'] as String, (m['size'] as num).toInt()),
      ];

  /// Opens Android's file chooser. Resolves to the number of files chosen.
  Future<int> pick() async {
    try {
      final files = _parse(await _c.invokeMethod<List<Object?>>('files.pick'));
      return _accept(files);
    } on MissingPluginException {
      return 0;
    }
  }

  /// Files other apps shared to Solo through the Android Share menu.
  Future<int> pullShared() async {
    try {
      return _accept(_parse(await _c.invokeMethod<List<Object?>>('files.takeShared')));
    } on MissingPluginException {
      return 0;
    }
  }

  int _accept(List<StagedFile> files) {
    if (files.isEmpty) return 0;
    pending.addAll(files);
    _staged.addAll(files.map((f) => f.path));
    message = null;
    notifyListeners();
    // One computer online: no need to ask where to send.
    if (destination != null) {
      sendPending();
    }
    return files.length;
  }

  Future<void> sendPending() async {
    final to = destination;
    if (to == null) {
      message = onlineComputers.isEmpty
          ? (computers.isEmpty ? 'Pair with your computer first (Devices tab).' : 'Your computer is not reachable right now. Make sure Solo is running on it.')
          : 'Choose which computer to send to.';
      notifyListeners();
      return;
    }
    final files = List.of(pending);
    pending.clear();
    message = null;
    notifyListeners();
    for (final f in files) {
      final err = await link.sendFile(to.id, f.path, f.name);
      if (err != null) message = '${f.name}: $err';
    }
    notifyListeners();
  }

  void discardPending() {
    pending.clear();
    notifyListeners();
    cleanupIfIdle();
  }

  void choose(String id) {
    target = id;
    notifyListeners();
  }

  /// Delete the temporary copies once nothing is being sent and nothing is waiting.
  Future<void> cleanupIfIdle() async {
    if (_staged.isEmpty || link.state.transfers.any((t) => t.active)) return;
    final keep = {for (final f in pending) f.path};
    final gone = _staged.where((p) => !keep.contains(p)).toList();
    if (gone.isEmpty) return;
    _staged.removeAll(gone);
    try {
      await _c.invokeMethod('files.cleanup', gone);
    } on MissingPluginException {
      // not on a phone
    }
  }
}
