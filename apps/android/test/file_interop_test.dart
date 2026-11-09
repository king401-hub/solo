import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/link/file_sender.dart';
import 'package:solo_android/relay/e2e.dart';
import 'package:solo_android/relay/relay_client.dart';

/// Cross-language: the Dart FileSender sends real files through the real relay (end-to-end encrypted) to the real
/// TypeScript desktop receiver (Inbox), and the bytes on the desktop's disk must be identical.
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

  // Windows may still hold a just-closed file for a moment; a leftover temp folder must not fail the test.
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

  test('phone sends files to the desktop over the relay: identical bytes, progress, cancel, offline failure', () async {
    final s = await ServerSocket.bind('127.0.0.1', 0);
    final port = s.port;
    await s.close();
    final inboxDir = Directory.systemTemp.createTempSync('solo-inbox-test-');
    addTearDown(() => tryDelete(inboxDir));
    final work = Directory.systemTemp.createTempSync('solo-send-test-');
    addTearDown(() => tryDelete(work));

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
    final laptop = await Process.start('npx', ['tsx', 'tools/interop-laptop.ts', 'ws://127.0.0.1:$port', inboxDir.path], workingDirectory: '$root/apps/desktop', runInShell: true);
    procs.add(laptop);
    laptop.stderr.drain<void>();
    laptop.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      try {
        events.add(jsonDecode(l) as Map<String, dynamic>);
      } catch (_) {}
    });
    await until(() => events.any((e) => e['event'] == 'pairing'), ms: 60000);
    final pairing = events.firstWhere((e) => e['event'] == 'pairing');
    final laptopId = pairing['id'] as String;

    late FileSender sender;
    final client = RelayClient(
      identity: await generateIdentity(),
      self: () => (name: 'Test phone', kind: 'android', appVersion: '0.1.0'),
      peers: const [],
      onMessage: (from, env) => sender.handle(from, env['type'] as String, Map<String, dynamic>.from(env['payload'] as Map)),
      onDisconnected: (id) => sender.peerLost(id),
    );
    addTearDown(client.stop);
    var changes = 0;
    sender = FileSender(send: client.send, onChange: () => changes++, peerName: (_) => 'Interop laptop');
    addTearDown(sender.dispose);
    client.setUrl('ws://127.0.0.1:$port');
    await until(() => client.status == RelayStatus.online);
    expect(await client.joinPairing(pairing['code'] as String), isNull);
    await until(() => events.any((e) => e['event'] == 'paired'));

    // a multi-chunk file (about 600 KB: more chunks than the window), an empty file, and a name that tries to escape
    final rnd = Random(42);
    final big = Uint8List.fromList(List.generate(600 * 1024 + 17, (_) => rnd.nextInt(256)));
    final bigFile = File('${work.path}/big.bin')..writeAsBytesSync(big);
    final emptyFile = File('${work.path}/empty.txt')..writeAsBytesSync(const []);
    final evil = File('${work.path}/evil.txt')..writeAsStringSync('not a path');

    await sender.sendFile(laptopId, bigFile.path, 'big.bin');
    await sender.sendFile(laptopId, emptyFile.path, 'empty.txt');
    await sender.sendFile(laptopId, evil.path, '..\\..\\Windows\\evil.txt');
    await until(() => sender.transfers.where((t) => t.status == TransferStatus.done).length == 3, ms: 60000);
    expect(sender.transfers.every((t) => t.error == null), true);
    expect(changes, greaterThan(5)); // progress was reported along the way

    expect(File('${inboxDir.path}/big.bin').readAsBytesSync(), big);
    expect(File('${inboxDir.path}/empty.txt').lengthSync(), 0);
    expect(File('${inboxDir.path}/evil.txt').readAsStringSync(), 'not a path');
    expect(inboxDir.parent.listSync().whereType<File>().where((f) => f.path.endsWith('evil.txt')), isEmpty, reason: 'nothing may land outside the folder');
    expect(inboxDir.listSync().whereType<File>().where((f) => f.path.endsWith('.part')), isEmpty);

    // the same name again never overwrites
    await sender.sendFile(laptopId, evil.path, 'evil.txt');
    await until(() => File('${inboxDir.path}/evil (1).txt').existsSync() && sender.transfers.where((t) => t.status == TransferStatus.done).length == 4);

    // a cancel stops it and leaves no half file on the desktop
    final huge = File('${work.path}/huge.bin')..writeAsBytesSync(Uint8List(20 * 1024 * 1024));
    final id = (await sender.sendFile(laptopId, huge.path, 'huge.bin'))!;
    await until(() => sender.transfers.any((t) => t.id == id && t.sent > 0));
    sender.cancel(id);
    expect(sender.transfers.firstWhere((t) => t.id == id).status, TransferStatus.cancelled);
    await Future<void>.delayed(const Duration(seconds: 2));
    expect(inboxDir.listSync().whereType<File>().where((f) => f.path.endsWith('.part') || f.path.endsWith('huge.bin')), isEmpty);

    // sending to a device that is not reachable fails clearly instead of hanging
    final lost = await sender.sendFile('0' * 64, evil.path, 'nope.txt');
    expect(lost, isNotNull);
    final failed = sender.transfers.firstWhere((t) => t.id == lost);
    expect(failed.status, TransferStatus.failed);
    expect(failed.error, contains('not reachable'));
  }, timeout: const Timeout(Duration(minutes: 4)));
}
