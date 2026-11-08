import 'package:flutter/material.dart';
import 'dart:async';

import '../link/link_api.dart';
import '../wake/wake_channel.dart';
import 'voice_cards.dart';

/// Assistant settings shared with the desktop. Edits here appear on the PC (and vice versa) within a moment while
/// connected, and are merged on reconnect if either side changed them offline.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.link, this.wake});
  final LinkApi link;
  final WakeChannel? wake; // injectable for tests
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  double? _rate, _follow; // live slider values while dragging
  late final WakeChannel _wake = widget.wake ?? WakeChannel();
  WakeStatus _ws = const WakeStatus();
  String? _wakeMsg;
  Timer? _poll;

  Future<void> _refreshWake() async {
    final st = await _wake.status();
    if (mounted) setState(() => _ws = st);
  }

  @override
  void initState() {
    super.initState();
    _refreshWake();
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refreshWake());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _toggleWake(bool on) async {
    setState(() => _wakeMsg = null);
    if (on) {
      final r = await _wake.start();
      if (r == 'denied') {
        setState(() => _wakeMsg =
            'Solo needs the microphone permission to hear its name. Allow it in Android Settings > Apps > Solo > Permissions.');
      }
    } else {
      await _wake.stop();
    }
    await Future<void>.delayed(const Duration(milliseconds: 600));
    await _refreshWake();
  }

  num _n(Map<String, dynamic> s, String k, num d) => (s[k] is num) ? s[k] as num : d;

  String _syncText(LinkState s) {
    if (!s.paired) return 'Not paired. Settings are kept on this phone and will merge when you pair.';
    final online = s.onlinePeers;
    if (online.isNotEmpty && s.status != LinkStatus.connected) {
      final t2 = s.lastSync == null ? null : DateTime.fromMillisecondsSinceEpoch(s.lastSync!);
      final when2 = t2 == null ? '' : ' · last sync ${t2.hour.toString().padLeft(2, '0')}:${t2.minute.toString().padLeft(2, '0')}';
      return 'In sync with ${online.map((p) => p.name).join(', ')} over the internet$when2';
    }
    final t = s.lastSync == null ? null : DateTime.fromMillisecondsSinceEpoch(s.lastSync!);
    final when = t == null ? '' : ' · last sync ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    return s.status == LinkStatus.connected
        ? 'In sync with ${s.desktopName}$when'
        : 'Offline. Changes are saved and will sync when ${s.desktopName ?? 'your PC'} is reachable$when';
  }

  @override
  Widget build(BuildContext context) {
    final link = widget.link;
    final st = link.state;
    final s = st.settings;
    final rate = _rate ?? _n(s, 'speechRate', 1).toDouble().clamp(0.5, 2.0);
    final follow = _follow ?? _n(s, 'followUpSeconds', 12).toDouble().clamp(0, 60);
    final gender = (s['voiceGender'] as String?) ?? 'female';
    final words = (s['wakeWords'] is List) ? List<String>.from(s['wakeWords'] as List) : ['hey solo', 'hey solomon'];

    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Settings', style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 4),
      Text(_syncText(st), key: const Key('syncText'), style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Solo’s voice'),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'female', label: Text('Female')),
                ButtonSegment(value: 'male', label: Text('Male')),
                ButtonSegment(value: 'any', label: Text('Default')),
              ],
              selected: {gender},
              onSelectionChanged: (v) => link.setAssistantSetting('voiceGender', v.first),
            ),
            const SizedBox(height: 16),
            Text('Speech speed (${rate.toStringAsFixed(1)}×)'),
            Slider(
              value: rate,
              min: 0.5,
              max: 2,
              divisions: 15,
              onChanged: (v) => setState(() => _rate = v),
              onChangeEnd: (v) async {
                await link.setAssistantSetting('speechRate', double.parse(v.toStringAsFixed(1)));
                if (mounted) setState(() => _rate = null);
              },
            ),
            Text('Keep listening after a reply (${follow.round()}s)'),
            Slider(
              value: follow.toDouble(),
              min: 0,
              max: 60,
              divisions: 30,
              onChanged: (v) => setState(() => _follow = v),
              onChangeEnd: (v) async {
                await link.setAssistantSetting('followUpSeconds', v.round());
                if (mounted) setState(() => _follow = null);
              },
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Also wake on just “Solo”'),
              subtitle: const Text('More convenient, more false wakes'),
              value: (s['quickWord'] as bool?) ?? false,
              onChanged: (v) => link.setAssistantSetting('quickWord', v),
            ),
            const SizedBox(height: 8),
            const Text('Wake words'),
            Wrap(spacing: 8, children: [for (final w in words) Chip(label: Text(w))]),
          ]),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Listen for “Hey Solo” on this phone'),
              subtitle: const Text('Say “Hey Solo”, “Hi Solo”, “Solo” or “Solomon”. Solo answers by voice without opening the app.'),
              value: _ws.running,
              onChanged: _toggleWake,
            ),
            if (_ws.running)
              const Text('Listening. Android shows its microphone indicator and a notification while this is on. '
                  'Audio is recognised on this phone and never stored or sent anywhere.'),
            if (_wakeMsg != null) Text(_wakeMsg!, style: const TextStyle(color: Colors.redAccent)),
            if (_ws.wanted && !_ws.running && _ws.micGranted)
              const Text('Listening was stopped by Android. Open the switch again to restart it. On Huawei, also allow Solo to run in the background in Battery settings.'),
            const SizedBox(height: 8),
            Text('Limits: after a phone restart, or if you force-stop Solo, listening stays off until you switch it on again here.',
                style: Theme.of(context).textTheme.bodySmall),
            if (_ws.recent.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('Recently heard'),
              for (final h in _ws.recent.take(5))
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(h.text),
                  subtitle: h.score == null ? null : Text('${h.owner == true ? 'your voice' : 'another voice'} (match ${h.score!.toStringAsFixed(2)})'),
                  trailing: Text(h.accepted ? 'for Solo' : h.owner == false ? 'ignored (not your voice)' : 'ignored'),
                ),
            ],
          ]),
        ),
      ),
      const SizedBox(height: 12),
      MyVoiceCard(wake: _wake),
      const SizedBox(height: 12),
      CorrectionsCard(wake: _wake),
    ]);
  }
}
