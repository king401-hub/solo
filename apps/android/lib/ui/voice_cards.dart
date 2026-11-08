import 'package:flutter/material.dart';

import '../wake/wake_channel.dart';
import 'theme.dart';

const enrollSentences = [
  'Good morning, this is my voice and I am teaching Solo to recognise me.',
  'The quick brown fox jumps over the lazy dog near the old market.',
  'Please open my project folder and show me what changed yesterday.',
  'I will call my brother in Lagos later, and then send a message to my team.',
  'Hello Solo, can you hear me clearly? This is how I normally speak.',
];

/// "My voice": teach Solo your voice so it answers you and ignores other people. Same capabilities as the desktop app.
/// The voice print is a set of numbers kept on this phone only, encrypted with the Android Keystore, never synced.
class MyVoiceCard extends StatefulWidget {
  const MyVoiceCard({super.key, required this.wake});
  final WakeChannel wake;
  @override
  State<MyVoiceCard> createState() => _MyVoiceCardState();
}

class _MyVoiceCardState extends State<MyVoiceCard> {
  VoiceStatus _status = const VoiceStatus();
  VoiceConfig _cfg = const VoiceConfig();
  int? _step; // enrolment in progress: index of the sentence to read
  bool _busy = false; // recording or analysing
  String? _msg;
  TestResult? _test;
  double? _strictDrag;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final s = await widget.wake.voiceStatus();
    final c = await widget.wake.voiceConfig();
    if (mounted) setState(() { _status = s; _cfg = c; });
  }

  Future<void> _begin() async {
    setState(() { _busy = true; _msg = 'Loading the voice model (the first time takes a little while)…'; });
    final err = await widget.wake.voiceWarmup();
    if (!mounted) return;
    if (err != null) return setState(() { _busy = false; _msg = 'The voice model could not load: $err'; });
    await widget.wake.voiceEnrollStart();
    setState(() { _busy = false; _msg = null; _step = 0; });
  }

  Future<void> _record() async {
    setState(() { _busy = true; _msg = 'Listening… read the sentence now.'; });
    final r = await widget.wake.voiceEnrollRecord();
    if (!mounted) return;
    if (!r.ok) return setState(() { _busy = false; _msg = r.reason ?? 'That did not work. Try again.'; });
    if (r.count >= enrollSentences.length) {
      setState(() => _msg = 'Analysing your recordings…');
      final f = await widget.wake.voiceEnrollFinish();
      await _refresh();
      if (!mounted) return;
      setState(() { _busy = false; _step = null; _msg = f.ok ? 'Done. Solo will now recognise your voice.' : (f.reason ?? 'The recordings were not consistent enough. Please try again.'); });
    } else {
      setState(() { _busy = false; _msg = null; _step = r.count; });
    }
  }

  Future<void> _testVoice() async {
    setState(() { _busy = true; _test = null; _msg = 'Listening… say a full sentence.'; });
    final t = await widget.wake.voiceTest();
    if (mounted) setState(() { _busy = false; _msg = null; _test = t; });
  }

  Future<void> _set(Map<String, Object> patch) async {
    await widget.wake.setVoiceConfig(patch);
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    final strict = _strictDrag ?? _cfg.strictness;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('My voice', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text(
              'Teach Solo your voice so it answers you and ignores other people. Solo keeps a numeric voice print on this phone only (no recordings, never synced), encrypted with Android. '
              'This is a convenience, not a lock like a fingerprint: a recording or a close imitation of your voice might fool it, and noise or a cold might make it miss you. Solo never uses it to approve anything sensitive.',
              style: small),
          const SizedBox(height: 12),
          if (_step == null && !_status.enrolled)
            FilledButton(key: const Key('teachVoice'), onPressed: _busy ? null : _begin, child: const Text('Teach Solo my voice')),
          if (_step != null) ...[
            Text('Sentence ${_step! + 1} of ${enrollSentences.length}. Tap Record, then read this aloud at your normal volume:'),
            Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text('“${enrollSentences[_step!]}”', style: Theme.of(context).textTheme.titleMedium)),
            Row(children: [
              FilledButton(key: const Key('recordClip'), onPressed: _busy ? null : _record, child: Text(_busy ? 'Listening…' : 'Record')),
              const SizedBox(width: 8),
              TextButton(
                  onPressed: () async { await widget.wake.voiceEnrollCancel(); if (mounted) setState(() { _step = null; _busy = false; _msg = null; }); },
                  child: const Text('Cancel')),
            ]),
            Text('Use a quiet room. Only you should be speaking. Listening for the wake word pauses while you record.', style: small),
          ],
          if (_msg != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_msg!, key: const Key('voiceMsg'))),
          if (_status.enrolled && _step == null) ...[
            Text('Voice print saved${_status.createdAt != null ? ' on ${_status.createdAt!.toLocal().toString().substring(0, 10)}' : ''}'
                '${_status.encrypted ? '' : ' (not encrypted: this phone could not provide encryption)'}.', style: small),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Only respond to my voice'),
              subtitle: const Text('Other people cannot wake or command Solo.'),
              value: _cfg.onlyMyVoice,
              onChanged: (v) => _set({'onlyMyVoice': v}),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Answer my greetings without a wake word'),
              subtitle: const Text('Say “hello”, “good morning” or “how far” and Solo answers, only if it is you.'),
              value: _cfg.greetingsWake,
              onChanged: (v) => _set({'greetingsWake': v}),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Let me interrupt Solo by talking'),
              subtitle: const Text('Only your voice can stop Solo mid-sentence.'),
              value: _cfg.allowInterrupt,
              onChanged: (v) => _set({'allowInterrupt': v}),
            ),
            Text('Strictness: ${strict < 0.34 ? 'lenient' : strict > 0.66 ? 'strict' : 'balanced'} (match needed: ${(0.74 + (0.92 - 0.74) * strict).toStringAsFixed(2)})'),
            Slider(
              value: strict,
              onChanged: (v) => setState(() => _strictDrag = v),
              onChangeEnd: (v) async { await _set({'strictness': v}); if (mounted) setState(() => _strictDrag = null); },
            ),
            Text('Lenient: fewer misses, more chance another person is accepted. Strict: the opposite. Use the test with your own voice to find the right setting.', style: small),
            const SizedBox(height: 8),
            Row(children: [
              OutlinedButton(key: const Key('testVoice'), onPressed: _busy ? null : _testVoice, child: Text(_busy ? 'Listening…' : 'Test my voice')),
              const SizedBox(width: 12),
              if (_test != null)
                Expanded(
                  child: Text(
                    _test!.score != null
                        ? 'Match ${_test!.score!.toStringAsFixed(2)} (needs ${_test!.threshold.toStringAsFixed(2)}): ${_test!.owner == true ? 'recognised as you' : 'not recognised'}'
                        : (_test!.note ?? ''),
                    key: const Key('testResult'),
                    style: TextStyle(color: _test!.owner == true ? SoloColors.ok : _test!.score != null ? SoloColors.danger : null),
                  ),
                ),
            ]),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: [
              OutlinedButton(onPressed: _busy ? null : _begin, child: const Text('Record my voice again')),
              OutlinedButton(
                key: const Key('deleteVoice'),
                onPressed: _busy ? null : () async {
                  final ok = await showDialog<bool>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: const Text('Delete your voice print?'),
                      content: const Text('Solo will stop recognising your voice on this phone until you teach it again.'),
                      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete'))],
                    ),
                  );
                  if (ok == true) { await widget.wake.voiceReset(); _test = null; await _refresh(); }
                },
                child: const Text('Delete my voice print'),
              ),
            ]),
          ],
        ]),
      ),
    );
  }
}

/// Words Solo should fix: if it hears "sorry low" when you say "Solo", add it here. Applied before Solo decides what you said.
class CorrectionsCard extends StatefulWidget {
  const CorrectionsCard({super.key, required this.wake});
  final WakeChannel wake;
  @override
  State<CorrectionsCard> createState() => _CorrectionsCardState();
}

class _CorrectionsCardState extends State<CorrectionsCard> {
  List<Correction> _rules = const [];
  final _heard = TextEditingController();
  final _meant = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await widget.wake.corrections();
    if (mounted) setState(() => _rules = r);
  }

  Future<void> _save(List<Correction> next) async {
    await widget.wake.setCorrections(next);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Words Solo should fix', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text('If Solo mishears a word (especially with an accent or a local expression), teach it here: “sorry low” means “Solo”. Kept on this phone.', style: small),
          const SizedBox(height: 8),
          TextField(controller: _heard, decoration: const InputDecoration(labelText: 'Solo heard…', border: OutlineInputBorder())),
          const SizedBox(height: 8),
          TextField(controller: _meant, decoration: const InputDecoration(labelText: 'I said…', border: OutlineInputBorder())),
          const SizedBox(height: 8),
          FilledButton.tonal(
            key: const Key('addCorrection'),
            onPressed: () async {
              final h = _heard.text.trim().toLowerCase(), m = _meant.text.trim();
              if (h.isEmpty || m.isEmpty) return;
              await _save([..._rules.where((r) => r.heard != h), Correction(h, m)]);
              _heard.clear();
              _meant.clear();
            },
            child: const Text('Add'),
          ),
          for (final r in _rules)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('“${r.heard}” → “${r.meant}”'),
              trailing: IconButton(icon: const Icon(Icons.close), tooltip: 'Remove', onPressed: () => _save(_rules.where((x) => x.heard != r.heard).toList())),
            ),
        ]),
      ),
    );
  }
}
