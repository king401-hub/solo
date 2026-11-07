import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/link/link_client.dart';
import 'package:solo_android/ui/settings_screen.dart';
import 'package:solo_android/wake/wake_channel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('solo/wake');

  Future<void> pumpSettings(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SettingsScreen(link: LinkClient(), wake: WakeChannel(channel)))));
    await tester.pump(const Duration(milliseconds: 50));
  }

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  testWidgets('shows listening state and recently heard from the native service', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'status') {
        return {
          'running': true,
          'wanted': true,
          'micGranted': true,
          'recent': jsonEncode([
            {'t': 1000, 'text': 'hey solo open chrome', 'accepted': true},
            {'t': 900, 'text': 'what a lovely day', 'accepted': false},
          ]),
        };
      }
      return null;
    });
    await pumpSettings(tester);
    expect(tester.widget<SwitchListTile>(find.widgetWithText(SwitchListTile, 'Listen for “Hey Solo” on this phone')).value, true);
    expect(find.text('hey solo open chrome'), findsOneWidget);
    expect(find.text('for Solo'), findsOneWidget);
    expect(find.text('ignored'), findsOneWidget);
    await tester.pumpWidget(const SizedBox()); // dispose the poll timer
  });

  testWidgets('permission denial is explained, not silent', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'status') return {'running': false, 'wanted': false, 'micGranted': false, 'recent': '[]'};
      if (call.method == 'start') return 'denied';
      return null;
    });
    await pumpSettings(tester);
    await tester.ensureVisible(find.byType(Switch).last);
    await tester.pump();
    await tester.tap(find.byType(Switch).last);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('needs the microphone permission'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpWidget(const SizedBox());
  });
}
