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

  testWidgets('shell shows unpaired state and navigates to Devices', (tester) async {
    await tester.pumpWidget(SoloApp(link: LinkClient()));
    expect(find.text('Not paired'), findsOneWidget);
    await tester.tap(find.text('Devices'));
    await tester.pump();
    expect(find.text('Pair with desktop'), findsOneWidget);
  });
}
