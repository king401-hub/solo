import 'dart:convert';

import 'package:flutter/services.dart';

class WakeStatus {
  const WakeStatus({this.running = false, this.wanted = false, this.micGranted = false, this.recent = const []});
  final bool running;
  final bool wanted; // user turned it on (it should be running)
  final bool micGranted;
  final List<WakeHeard> recent;
}

class WakeHeard {
  const WakeHeard(this.at, this.text, this.accepted);
  final DateTime at;
  final String text;
  final bool accepted;
}

/// Bridge to the native wake-word service (android/.../WakeService.kt).
class WakeChannel {
  WakeChannel([MethodChannel? channel]) : _c = channel ?? const MethodChannel('solo/wake');
  final MethodChannel _c;

  Future<WakeStatus> status() async {
    try {
      final m = await _c.invokeMapMethod<String, dynamic>('status');
      if (m == null) return const WakeStatus();
      final recent = <WakeHeard>[];
      try {
        for (final e in jsonDecode(m['recent'] as String) as List) {
          recent.add(WakeHeard(DateTime.fromMillisecondsSinceEpoch(e['t'] as int), e['text'] as String, e['accepted'] as bool));
        }
      } catch (_) {}
      return WakeStatus(
        running: m['running'] == true,
        wanted: m['wanted'] == true,
        micGranted: m['micGranted'] == true,
        recent: recent,
      );
    } on MissingPluginException {
      return const WakeStatus(); // e.g. widget tests / non-Android
    }
  }

  /// Returns 'started', 'denied' (microphone permission refused) or 'busy'.
  Future<String> start() async => (await _c.invokeMethod<String>('start')) ?? 'error';
  Future<void> stop() async => _c.invokeMethod('stop');
}
