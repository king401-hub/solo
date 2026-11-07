import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/link/link_client.dart';
import 'package:solo_android/link/proof.dart';
import 'package:solo_android/main.dart';

void main() {
  // Identical vectors to apps/desktop/src/main/link/link.test.ts
  test('pairProof matches desktop vector', () {
    expect(pairProof('123456', '00112233445566778899aabbccddeeff', 'phone-00001', 'ab' * 32),
        'bb71c28157b8a9dedf480cb8cd33f8061bb64aad0a1d7c14c4d50c1d5c4a7d82');
  });
  test('authProof matches desktop vector', () {
    expect(authProof('cd' * 32, '00112233445566778899aabbccddeeff', 'phone-00001'),
        '916e027001e174024860983336d1c1b850e3f939968c9e9bf5c7718507d9c0fd');
  });
  test('sas matches desktop vector', () {
    expect(sas('00112233445566778899aabbccddeeff', 'ab' * 32), '5621');
  });

  test('LinkState survives the service isolate boundary', () {
    const s = LinkState(status: LinkStatus.connected, desktopName: 'PC', host: '10.0.0.2', port: 47821, deviceName: 'Pixel', sas: '1234', autoPair: true);
    final back = LinkState.fromJson(Map<dynamic, dynamic>.from(s.toJson()));
    expect(back.status, LinkStatus.connected);
    expect(back.desktopName, 'PC');
    expect(back.sas, '1234');
    expect(back.autoPair, true);
    expect(back.paired, true);
  });

  testWidgets('shell shows unpaired state and navigates to Devices', (tester) async {
    await tester.pumpWidget(SoloApp(link: LinkClient()));
    expect(find.text('Not paired'), findsOneWidget);
    await tester.tap(find.text('Devices'));
    await tester.pump();
    expect(find.text('Pair with desktop'), findsOneWidget);
    expect(find.text('Rename this phone'), findsNothing);
    expect(find.byTooltip('Rename this phone'), findsOneWidget);
  });
}
