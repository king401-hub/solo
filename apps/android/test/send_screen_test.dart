import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/link/file_sender.dart';
import 'package:solo_android/link/link_api.dart';
import 'package:solo_android/send/send_controller.dart';
import 'package:solo_android/ui/send_screen.dart';

class FakeLink extends LinkApi {
  LinkState _s = const LinkState();
  @override
  LinkState get state => _s;
  set state(LinkState s) {
    _s = s;
    notifyListeners();
  }

  final sent = <(String, String, String)>[];
  String? refuse;
  final cancelled = <String>[];
  var cleared = 0;

  @override
  Future<String?> sendFile(String peerId, String path, String name) async {
    sent.add((peerId, path, name));
    return refuse;
  }

  @override
  Future<void> cancelTransfer(String id) async => cancelled.add(id);
  @override
  Future<void> clearTransfers() async => cleared++;
  @override
  dynamic noSuchMethod(Invocation i) => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('solo/wake');
  late FakeLink link;
  late List<String> calls;
  late List<Map<String, Object>> picked;

  setUp(() {
    link = FakeLink();
    calls = [];
    picked = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (c) async {
      calls.add(c.method);
      if (c.method == 'files.pick') return picked;
      if (c.method == 'files.takeShared') return picked;
      return {'ok': true};
    });
  });
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  Future<SendController> pump(WidgetTester t) async {
    final c = SendController(link, channel);
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SendScreen(controller: c))));
    await t.pumpAndSettle();
    return c;
  }

  const pc = PeerInfo(id: 'pc1', name: 'Office PC', kind: 'windows', online: true, via: 'lan');

  testWidgets('without a paired computer it says to pair first', (t) async {
    await pump(t);
    expect(find.textContaining('No computer is paired'), findsOneWidget);
    expect(find.byKey(const Key('pickFiles')), findsNothing);
  });

  testWidgets('a paired computer that is offline is explained', (t) async {
    link.state = const LinkState(peers: [PeerInfo(id: 'pc1', name: 'Office PC', kind: 'windows', online: false)]);
    await pump(t);
    expect(find.byKey(const Key('sendOffline')), findsOneWidget);
  });

  testWidgets('choosing a file with one computer online sends it straight away and cleans up afterwards', (t) async {
    link.state = const LinkState(peers: [pc]);
    final c = await pump(t);
    expect(find.text('Sending to Office PC'), findsOneWidget);
    picked = [{'path': '/cache/outgoing/a/photo.jpg', 'name': 'photo.jpg', 'size': 2048}];
    await t.tap(find.byKey(const Key('pickFiles')));
    await t.pumpAndSettle();
    expect(link.sent, [('pc1', '/cache/outgoing/a/photo.jpg', 'photo.jpg')]);
    expect(c.pending, isEmpty);
    // transfer finishes -> temporary copy is removed
    link.state = const LinkState(peers: [pc], transfers: [TransferInfo(id: 't', name: 'photo.jpg', size: 2048, peerId: 'pc1', peerName: 'Office PC', sent: 2048, status: TransferStatus.done)]);
    await c.cleanupIfIdle();
    await t.pumpAndSettle();
    expect(find.text('Sent to Office PC'), findsOneWidget);
    expect(calls, contains('files.cleanup'));
  });

  testWidgets('no cleanup while a transfer is still running', (t) async {
    link.state = const LinkState(peers: [pc]);
    final c = await pump(t);
    picked = [{'path': '/cache/outgoing/a/big.zip', 'name': 'big.zip', 'size': 5000000}];
    await c.pick();
    link.state = const LinkState(peers: [pc], transfers: [TransferInfo(id: 't', name: 'big.zip', size: 5000000, peerId: 'pc1', peerName: 'Office PC', sent: 1000000, status: TransferStatus.sending)]);
    await c.cleanupIfIdle();
    await t.pumpAndSettle();
    expect(calls, isNot(contains('files.cleanup')));
    expect(find.textContaining('1.0 MB of 5.0 MB'), findsOneWidget);
    await t.tap(find.byTooltip('Cancel'));
    expect(link.cancelled, ['t']);
  });

  testWidgets('with two computers online it asks which one, then sends there', (t) async {
    link.state = const LinkState(peers: [pc, PeerInfo(id: 'pc2', name: 'Laptop', kind: 'windows', online: true, via: 'relay')]);
    final c = await pump(t);
    picked = [{'path': '/cache/outgoing/b/doc.pdf', 'name': 'doc.pdf', 'size': 10}];
    await c.pick();
    await t.pumpAndSettle();
    expect(link.sent, isEmpty);
    expect(find.text('Ready to send'), findsOneWidget);
    expect(tester(t, const Key('sendNow')).onPressed, isNull);
    await t.tap(find.text('Laptop'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('sendNow')));
    await t.pumpAndSettle();
    expect(link.sent.single.$1, 'pc2');
  });

  testWidgets('a refusal from the computer is shown', (t) async {
    link.state = const LinkState(peers: [pc]);
    link.refuse = 'That file is larger than 2 GB.';
    final c = await pump(t);
    picked = [{'path': '/p/x.iso', 'name': 'x.iso', 'size': 3}];
    await c.pick();
    await t.pumpAndSettle();
    expect(find.textContaining('larger than 2 GB'), findsOneWidget);
  });

  testWidgets('failed and cancelled transfers show why', (t) async {
    link.state = const LinkState(peers: [pc], transfers: [
      TransferInfo(id: 'a', name: 'a.txt', size: 5, peerId: 'pc1', peerName: 'Office PC', status: TransferStatus.failed, error: 'Office PC went offline.'),
      TransferInfo(id: 'b', name: 'b.txt', size: 5, peerId: 'pc1', peerName: 'Office PC', status: TransferStatus.cancelled),
    ]);
    await pump(t);
    expect(find.text('Office PC went offline.'), findsOneWidget);
    expect(find.text('Cancelled'), findsOneWidget);
    await t.tap(find.text('Clear finished'));
    expect(link.cleared, 1);
  });

  test('transfer info survives the trip between the service and the screen', () {
    const info = TransferInfo(id: 'x', name: 'n', size: 9, peerId: 'p', peerName: 'PC', sent: 4, status: TransferStatus.sending);
    final back = LinkState.fromJson(const LinkState(transfers: [info]).toJson()).transfers.single;
    expect((back.id, back.name, back.size, back.sent, back.status, back.progress), ('x', 'n', 9, 4, TransferStatus.sending, 4 / 9));
  });
}

FilledButton tester(WidgetTester t, Key k) => t.widget<FilledButton>(find.byKey(k));
