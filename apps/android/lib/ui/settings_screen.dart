import 'package:flutter/material.dart';
import '../link/link_api.dart';

/// Assistant settings shared with the desktop. Edits here appear on the PC (and vice versa) within a moment while
/// connected, and are merged on reconnect if either side changed them offline.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.link});
  final LinkApi link;
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  double? _rate, _follow; // live slider values while dragging

  num _n(Map<String, dynamic> s, String k, num d) => (s[k] is num) ? s[k] as num : d;

  String _syncText(LinkState s) {
    if (!s.paired) return 'Not paired. Settings are kept on this phone and will merge when you pair.';
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
    ]);
  }
}
