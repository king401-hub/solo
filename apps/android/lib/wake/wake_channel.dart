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
  const WakeHeard(this.at, this.text, this.accepted, {this.owner, this.score});
  final DateTime at;
  final String text;
  final bool accepted;
  final bool? owner; // null = voice recognition not used for this line
  final double? score;
}

class VoiceStatus {
  const VoiceStatus({this.enrolled = false, this.createdAt, this.pending = 0, this.needed = 4, this.encrypted = false});
  final bool enrolled;
  final DateTime? createdAt;
  final int pending;
  final int needed;
  final bool encrypted;
}

class VoiceConfig {
  const VoiceConfig({this.onlyMyVoice = true, this.greetingsWake = true, this.allowInterrupt = true, this.strictness = 0.25, this.threshold = 0.785});
  final bool onlyMyVoice, greetingsWake, allowInterrupt;
  final double strictness, threshold;
}

class ClipResult {
  const ClipResult(this.ok, this.count, [this.reason]);
  final bool ok;
  final int count;
  final String? reason;
}

class FinishResult {
  const FinishResult(this.ok, [this.reason]);
  final bool ok;
  final String? reason;
}

class TestResult {
  const TestResult({this.score, this.owner, required this.threshold, this.note});
  final double? score;
  final bool? owner;
  final double threshold;
  final String? note;
}

class Correction {
  const Correction(this.heard, this.meant);
  final String heard, meant;
}

/// Bridge to the native wake-word service and voice recognition (android/.../WakeService.kt, MainActivity.kt).
/// Everything about the owner's voice stays on this phone.
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
          recent.add(WakeHeard(DateTime.fromMillisecondsSinceEpoch(e['t'] as int), e['text'] as String, e['accepted'] as bool,
              owner: e['owner'] as bool?, score: (e['score'] as num?)?.toDouble()));
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

  // ---- owner's voice ----

  Future<Map<String, dynamic>> _map(String method, [Object? args]) async {
    try {
      return (await _c.invokeMapMethod<String, dynamic>(method, args)) ?? const {};
    } on MissingPluginException {
      return const {};
    }
  }

  Future<VoiceStatus> voiceStatus() async {
    final m = await _map('voice.status');
    return VoiceStatus(
      enrolled: m['enrolled'] == true,
      createdAt: m['createdAt'] is int ? DateTime.fromMillisecondsSinceEpoch(m['createdAt'] as int) : null,
      pending: (m['pending'] as int?) ?? 0,
      needed: (m['needed'] as int?) ?? 4,
      encrypted: m['encrypted'] == true,
    );
  }

  /// Loads the speaker model now (the first time it is copied out of the app, which takes a few seconds).
  Future<String?> voiceWarmup() async {
    final m = await _map('voice.warmup');
    return m['ok'] == true || m.isEmpty ? null : (m['error'] as String? ?? 'The voice model could not load');
  }

  Future<void> voiceEnrollStart() => _map('voice.enrollStart');
  Future<void> voiceEnrollCancel() => _map('voice.enrollCancel');

  /// Records one sentence and adds it to the voice print. Waits for speech, then a pause.
  Future<ClipResult> voiceEnrollRecord() async {
    final m = await _map('voice.enrollRecord');
    return ClipResult(m['ok'] == true, (m['count'] as int?) ?? 0, m['reason'] as String?);
  }

  Future<FinishResult> voiceEnrollFinish() async {
    final m = await _map('voice.enrollFinish');
    final q = (m['quality'] as Map?) ?? const {};
    return FinishResult(m['ok'] == true, q['reason'] as String?);
  }

  /// Records a phrase and reports the match score against the current threshold.
  Future<TestResult> voiceTest() async {
    final m = await _map('voice.test');
    return TestResult(
      score: (m['score'] as num?)?.toDouble(),
      owner: m['owner'] as bool?,
      threshold: (m['threshold'] as num?)?.toDouble() ?? 0.785,
      note: m['note'] as String?,
    );
  }

  Future<void> voiceReset() => _map('voice.reset');

  Future<VoiceConfig> voiceConfig() async {
    final m = await _map('voice.getConfig');
    if (m.isEmpty) return const VoiceConfig();
    return VoiceConfig(
      onlyMyVoice: m['onlyMyVoice'] != false,
      greetingsWake: m['greetingsWake'] != false,
      allowInterrupt: m['allowInterrupt'] != false,
      strictness: (m['strictness'] as num?)?.toDouble() ?? 0.25,
      threshold: (m['threshold'] as num?)?.toDouble() ?? 0.785,
    );
  }

  Future<void> setVoiceConfig(Map<String, Object> patch) => _map('voice.setConfig', patch);

  Future<List<Correction>> corrections() async {
    try {
      final l = await _c.invokeListMethod<Map>('voice.getCorrections');
      return [for (final m in l ?? const <Map>[]) Correction(m['heard'] as String, m['meant'] as String)];
    } on MissingPluginException {
      return const [];
    }
  }

  Future<void> setCorrections(List<Correction> list) =>
      _map('voice.setCorrections', [for (final c in list) {'heard': c.heard, 'meant': c.meant}]);
}
