import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/relay/e2e.dart';
import 'package:solo_android/relay/relay_client.dart';

/// Cross-language integration: the Dart phone client pairs with the real TypeScript desktop client through the real
/// relay server (all started as separate processes) and exchanges end-to-end encrypted messages.
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

  Future<void> until(bool Function() f, {int ms = 20000}) async {
    final end = DateTime.now().add(Duration(milliseconds: ms));
    while (!f() && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
    if (!f()) throw TimeoutException('condition not met within ${ms}ms');
  }

  test('phone <-> desktop over the relay: pair with a code, then encrypted messages both ways', () async {
    final s = await ServerSocket.bind('127.0.0.1', 0);
    final port = s.port;
    await s.close();

    final relay = await Process.start('npx', ['tsx', 'src/index.ts'],
        workingDirectory: '$root/apps/relay', environment: {'PORT': '$port'}, runInShell: true);
    procs.add(relay);
    relay.stdout.drain<void>();
    relay.stderr.drain<void>();
    await until(() {
      try {
        final r = Process.runSync('curl', ['-s', '-m', '2', 'http://127.0.0.1:$port/healthz'], runInShell: true);
        return r.stdout.toString().trim() == 'ok';
      } catch (_) {
        return false;
      }
    }, ms: 60000);

    final events = <Map<String, dynamic>>[];
    final laptop = await Process.start('npx', ['tsx', 'tools/interop-laptop.ts', 'ws://127.0.0.1:$port'],
        workingDirectory: '$root/apps/desktop', runInShell: true);
    procs.add(laptop);
    laptop.stderr.drain<void>();
    laptop.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      try {
        events.add(jsonDecode(l) as Map<String, dynamic>);
      } catch (_) {}
    });
    await until(() => events.any((e) => e['event'] == 'pairing'), ms: 60000);
    final pairing = events.firstWhere((e) => e['event'] == 'pairing');
    final code = pairing['code'] as String;
    final laptopId = pairing['id'] as String;

    final me = await generateIdentity();
    final got = <Map<String, dynamic>>[];
    final connected = Completer<RelayPeer>();
    final client = RelayClient(
      identity: me,
      self: () => (name: 'Test phone', kind: 'android', appVersion: '0.1.0'),
      peers: const [],
      onMessage: (from, env) => got.add(env),
      onConnected: (p) {
        if (!connected.isCompleted) connected.complete(p);
      },
    );
    addTearDown(client.stop);
    client.setUrl('ws://127.0.0.1:$port');
    await until(() => client.status == RelayStatus.online);

    // a wrong code fails cleanly and pairs nothing
    expect(await client.joinPairing('AAAA-BBBB-CCCC'), 'Code not found or expired');
    expect(client.peers, isEmpty);

    // the right code pairs, and each side learns the other's verified key
    expect(await client.joinPairing(code), isNull);
    expect(client.peers.single.id, laptopId);
    expect(client.peers.single.name, 'Interop laptop');
    expect(idOf(client.peers.single.pub), laptopId);
    final peer = await connected.future.timeout(const Duration(seconds: 15));
    expect(peer.id, laptopId);
    await until(() => events.any((e) => e['event'] == 'paired' && e['name'] == 'Test phone'));

    // phone -> desktop (desktop decrypts it) and desktop -> phone (the echo)
    expect(await client.send(laptopId, 'task.update', {'taskId': 't1', 'status': 'running', 'note': 'hello from phone'}), true);
    await until(() => events.any((e) => e['event'] == 'message' && e['type'] == 'task.update'));
    expect(events.firstWhere((e) => e['event'] == 'message')['payload']['note'], 'hello from phone');
    await until(() => got.any((e) => e['type'] == 'task.update'));
    expect(got.first['payload'], {'echo': 'hello from phone', 'from': 'laptop'});
    expect(got.first['from'], laptopId);

    // several more messages keep flowing in order (counters stay in sync across both implementations)
    for (var i = 0; i < 5; i++) {
      await client.send(laptopId, 'task.update', {'taskId': 't1', 'status': 'running', 'note': 'n$i'});
    }
    await until(() => got.where((e) => e['type'] == 'task.update').length >= 6);
    expect(got.where((e) => e['type'] == 'task.update').map((e) => e['payload']['echo']).toList(),
        ['hello from phone', 'n0', 'n1', 'n2', 'n3', 'n4']);
  }, timeout: const Timeout(Duration(minutes: 3)));
}
