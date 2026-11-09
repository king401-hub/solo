import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/link/file_receiver.dart';
import 'package:solo_android/relay/e2e.dart';
import 'package:solo_android/relay/relay_client.dart';

/// Cross-language, the other direction: the real TypeScript desktop Outbox sends files through the real relay (end-to-end
/// encrypted) to the Dart FileReceiver, and the bytes stored on the phone side must be identical.
void main() {
  final root = Directory.current.parent.parent.path;
  final procs = <Process>[];
  void kill(Process p) {
    if (Platform.isWindows) {
      Process.runSync('taskkill', ['/PID', '${p.pid}', '/T', '/F']);
    } else {
      p.kill();
    }
  }

  tearDownAll(() {
    for (final p in procs) {
      kill(p);
    }
  });

  void tryDelete(Directory d) {
    for (var i = 0; i < 10; i++) {
      try {
        if (d.existsSync()) d.deleteSync(recursive: true);
        return;
      } on FileSystemException {
        sleep(const Duration(milliseconds: 200));
      }
    }
  }

  Future<void> until(bool Function() f, {int ms = 60000}) async {
    final end = DateTime.now().add(Duration(milliseconds: ms));
    while (!f() && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
    if (!f()) throw TimeoutException('condition not met within ${ms}ms');
  }

  test('desktop sends files to the phone over the relay: identical bytes, rejection, cancel', () async {
    final s = await ServerSocket.bind('127.0.0.1', 0);
    final port = s.port;
    await s.close();
    final work = Directory.systemTemp.createTempSync('solo-pc-files-');
    addTearDown(() => tryDelete(work));
    final phoneDir = Directory.systemTemp.createTempSync('solo-phone-incoming-');
    addTearDown(() => tryDelete(phoneDir));

    final relay = await Process.start('npx', ['tsx', 'src/index.ts'], workingDirectory: '$root/apps/relay', environment: {'PORT': '$port'}, runInShell: true);
    procs.add(relay);
    relay.stdout.drain<void>();
    relay.stderr.drain<void>();
    await until(() {
      try {
        return Process.runSync('curl', ['-s', '-m', '2', 'http://127.0.0.1:$port/healthz'], runInShell: true).stdout.toString().trim() == 'ok';
      } catch (_) {
        return false;
      }
    }, ms: 60000);

    final events = <Map<String, dynamic>>[];
    final laptop = await Process.start('npx', ['tsx', 'tools/interop-laptop.ts', 'ws://127.0.0.1:$port'], workingDirectory: '$root/apps/desktop', runInShell: true);
    procs.add(laptop);
    laptop.stderr.drain<void>();
    laptop.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      try {
        events.add(jsonDecode(l) as Map<String, dynamic>);
      } catch (_) {}
    });
    void cmd(String c) => laptop.stdin.writeln(c);
    List<dynamic> lastTransfers() => events.lastWhere((e) => e['event'] == 'transfers', orElse: () => {'transfers': []})['transfers'] as List;
    await until(() => events.any((e) => e['event'] == 'pairing'), ms: 60000);
    final pairing = events.firstWhere((e) => e['event'] == 'pairing');

    late FileReceiver rx;
    late RelayClient client;
    client = RelayClient(
      identity: await generateIdentity(),
      self: () => (name: 'Test phone', kind: 'android', appVersion: '0.1.0'),
      peers: const [],
      onMessage: (from, env) => rx.handle(from, env['type'] as String, Map<String, dynamic>.from(env['payload'] as Map)),
      onDisconnected: (id) => rx.peerLost(id),
    );
    rx = FileReceiver(dir: phoneDir.path, send: client.send, onChange: () {}, peerName: (_) => 'Interop laptop');
    addTearDown(rx.dispose);
    addTearDown(client.stop);
    client.setUrl('ws://127.0.0.1:$port');
    await until(() => client.status == RelayStatus.online);
    expect(await client.joinPairing(pairing['code'] as String), isNull);
    await until(() => events.any((e) => e['event'] == 'paired'));

    // a multi-chunk file (more than the window), an empty one, and a hostile name
    final rnd = Random(7);
    final big = Uint8List.fromList(List.generate(500 * 1024 + 5, (_) => rnd.nextInt(256)));
    File('${work.path}/report.bin').writeAsBytesSync(big);
    File('${work.path}/empty.txt').writeAsBytesSync(const []);
    cmd('send ${work.path}/report.bin');
    await until(() => lastTransfers().any((t) => t['name'] == 'report.bin' && t['status'] == 'done'), ms: 60000);
    cmd('send ${work.path}/empty.txt');
    await until(() => lastTransfers().any((t) => t['name'] == 'empty.txt' && t['status'] == 'done'));

    expect(rx.received.map((f) => f.name).toSet(), {'report.bin', 'empty.txt'});
    final got = rx.received.firstWhere((f) => f.name == 'report.bin');
    expect(File(got.path).readAsBytesSync(), big);
    expect(got.fromName, 'Interop laptop');
    expect(File(rx.received.firstWhere((f) => f.name == 'empty.txt').path).lengthSync(), 0);
    expect(phoneDir.listSync().whereType<File>().where((f) => f.path.contains('.part')), isEmpty);

    // the same file again is kept next to the first, never over it
    cmd('send ${work.path}/report.bin');
    await until(() => rx.received.any((f) => f.name == 'report (1).bin'), ms: 60000);

    // a folder is refused by the desktop before anything is sent
    cmd('send ${work.path}');
    await until(() => events.any((e) => e['event'] == 'sendError'));

    // cancel in the middle leaves nothing half-written on the phone
    File('${work.path}/huge.bin').writeAsBytesSync(Uint8List(25 * 1024 * 1024));
    cmd('send ${work.path}/huge.bin');
    await until(() => lastTransfers().any((t) => t['name'] == 'huge.bin' && (t['sent'] as int) > 0 && t['status'] == 'sending'));
    cmd('cancel');
    await until(() => lastTransfers().any((t) => t['name'] == 'huge.bin' && t['status'] == 'cancelled'));
    await until(() => rx.receiving.isEmpty);
    expect(rx.received.any((f) => f.name == 'huge.bin'), false);
    expect(phoneDir.listSync().whereType<File>().where((f) => f.path.contains('.part')), isEmpty);
  }, timeout: const Timeout(Duration(minutes: 4)));
}
