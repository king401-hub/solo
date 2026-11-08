import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/ui/voice_cards.dart';
import 'package:solo_android/wake/wake_channel.dart';

/// A stand-in for the native side (WakeService / MainActivity): keeps simple state and records what the UI asks of it.
class FakeNative {
  bool enrolled = false;
  int pending = 0;
  Map<String, dynamic> nextRecord = {};
  Map<String, dynamic> nextTest = {'score': 0.91, 'owner': true, 'threshold': 0.785};
  Map<String, dynamic> cfg = {'onlyMyVoice': true, 'greetingsWake': true, 'allowInterrupt': true, 'strictness': 0.25, 'threshold': 0.785};
  final calls = <String>[];
  final received = <String, Object?>{};
  List<Map<String, String>> corrections = [];

  Future<Object?> handle(MethodCall c) async {
    calls.add(c.method);
    received[c.method] = c.arguments;
    switch (c.method) {
      case 'voice.status':
        return {'enrolled': enrolled, 'createdAt': enrolled ? 1700000000000 : null, 'pending': pending, 'needed': 4, 'encrypted': true};
      case 'voice.warmup':
        return {'ok': true};
      case 'voice.enrollStart':
        pending = 0;
        return {'ok': true};
      case 'voice.enrollRecord':
        if (nextRecord.isNotEmpty) return nextRecord;
        pending++;
        return {'ok': true, 'count': pending};
      case 'voice.enrollFinish':
        enrolled = true;
        return {'ok': true, 'quality': {'ok': true, 'clips': pending}};
      case 'voice.enrollCancel':
        pending = 0;
        return {'ok': true};
      case 'voice.test':
        return nextTest;
      case 'voice.reset':
        enrolled = false;
        return {'ok': true};
      case 'voice.getConfig':
        return cfg;
      case 'voice.setConfig':
        cfg = {...cfg, ...Map<String, dynamic>.from(c.arguments as Map)};
        return {'ok': true};
      case 'voice.getCorrections':
        return corrections;
      case 'voice.setCorrections':
        corrections = [for (final m in c.arguments as List) {'heard': (m as Map)['heard'] as String, 'meant': m['meant'] as String}];
        return {'ok': true};
    }
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('solo/wake');
  late FakeNative native;

  setUp(() {
    native = FakeNative();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, native.handle);
  });
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  Future<void> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final wake = WakeChannel(channel);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: Column(children: [MyVoiceCard(wake: wake), CorrectionsCard(wake: wake)])))));
    await tester.pumpAndSettle();
  }

  testWidgets('teaching Solo my voice: five sentences, then it is enrolled and the settings appear', (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('teachVoice')), findsOneWidget);
    await tester.tap(find.byKey(const Key('teachVoice')));
    await tester.pumpAndSettle();
    for (var i = 0; i < enrollSentences.length; i++) {
      expect(find.textContaining('Sentence ${i + 1} of 5'), findsOneWidget);
      expect(find.textContaining(enrollSentences[i]), findsOneWidget);
      await tester.tap(find.byKey(const Key('recordClip')));
      await tester.pumpAndSettle();
    }
    expect(find.text('Done. Solo will now recognise your voice.'), findsOneWidget);
    expect(find.text('Only respond to my voice'), findsOneWidget);
    expect(find.text('Answer my greetings without a wake word'), findsOneWidget);
    expect(native.calls, containsAllInOrder(['voice.warmup', 'voice.enrollStart', 'voice.enrollRecord', 'voice.enrollFinish']));
  });

  testWidgets('a rejected recording explains why and stays on the same sentence', (tester) async {
    native.nextRecord = {'ok': false, 'count': 0, 'reason': 'That was too short. Read the whole sentence (at least 3 seconds).'};
    await pump(tester);
    await tester.tap(find.byKey(const Key('teachVoice')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('recordClip')));
    await tester.pumpAndSettle();
    expect(find.textContaining('too short'), findsOneWidget);
    expect(find.textContaining('Sentence 1 of 5'), findsOneWidget);
  });

  testWidgets('cancelling enrolment goes back and tells the native side', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('teachVoice')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('teachVoice')), findsOneWidget);
    expect(native.calls, contains('voice.enrollCancel'));
  });

  testWidgets('Test my voice shows the score against the threshold and the verdict', (tester) async {
    native.enrolled = true;
    await pump(tester);
    await tester.tap(find.byKey(const Key('testVoice')));
    await tester.pumpAndSettle();
    expect(find.text('Match 0.91 (needs 0.79): recognised as you'), findsOneWidget);
    native.nextTest = {'score': 0.52, 'owner': false, 'threshold': 0.785};
    await tester.tap(find.byKey(const Key('testVoice')));
    await tester.pumpAndSettle();
    expect(find.text('Match 0.52 (needs 0.79): not recognised'), findsOneWidget);
    native.nextTest = {'note': 'That was too short to judge. Say a full sentence.', 'threshold': 0.785};
    await tester.tap(find.byKey(const Key('testVoice')));
    await tester.pumpAndSettle();
    expect(find.textContaining('too short to judge'), findsOneWidget);
  });

  testWidgets('switches are saved on the phone through the native side', (tester) async {
    native.enrolled = true;
    await pump(tester);
    await tester.tap(find.text('Only respond to my voice'));
    await tester.pumpAndSettle();
    expect(native.received['voice.setConfig'], {'onlyMyVoice': false});
    await tester.tap(find.text('Let me interrupt Solo by talking'));
    await tester.pumpAndSettle();
    expect(native.received['voice.setConfig'], {'allowInterrupt': false});
    expect(native.cfg['onlyMyVoice'], false);
  });

  testWidgets('deleting the voice print asks first, and only then deletes it', (tester) async {
    native.enrolled = true;
    await pump(tester);
    await tester.tap(find.byKey(const Key('deleteVoice')));
    await tester.pumpAndSettle();
    expect(find.text('Delete your voice print?'), findsOneWidget);
    await tester.tap(find.text('Cancel').last);
    await tester.pumpAndSettle();
    expect(native.enrolled, true);
    await tester.tap(find.byKey(const Key('deleteVoice')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(native.enrolled, false);
    expect(find.byKey(const Key('teachVoice')), findsOneWidget);
  });

  testWidgets('the explanation is honest that this is not a fingerprint', (tester) async {
    await pump(tester);
    expect(find.textContaining('not a lock like a fingerprint'), findsOneWidget);
    expect(find.textContaining('never synced'), findsOneWidget);
  });

  testWidgets('words Solo should fix can be added and removed', (tester) async {
    await pump(tester);
    await tester.enterText(find.widgetWithText(TextField, 'Solo heard…'), 'Sorry Low');
    await tester.enterText(find.widgetWithText(TextField, 'I said…'), 'Solo');
    await tester.tap(find.byKey(const Key('addCorrection')));
    await tester.pumpAndSettle();
    expect(find.text('“sorry low” → “Solo”'), findsOneWidget);
    expect(native.corrections, [{'heard': 'sorry low', 'meant': 'Solo'}]);
    await tester.tap(find.byTooltip('Remove'));
    await tester.pumpAndSettle();
    expect(native.corrections, isEmpty);
  });
}
