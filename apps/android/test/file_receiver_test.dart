import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/link/file_receiver.dart';
import 'package:solo_android/link/file_sender.dart';
import 'package:solo_android/link/file_util.dart';

void main() {
  late Directory tmp;
  late String dir;
  late List<(String, String, Map<String, dynamic>)> sent;
  late FileReceiver rx;

  FileReceiver make({int maxBytes = maxFileBytes}) =>
      FileReceiver(dir: dir, send: (to, type, p) async { sent.add((to, type, p)); return true; }, onChange: () {}, peerName: (_) => 'Office PC', maxBytes: maxBytes);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('solo-rx-');
    dir = '${tmp.path}/incoming';
    sent = [];
    rx = make();
  });
  tearDown(() {
    rx.dispose();
    for (var i = 0; i < 10; i++) {
      try {
        if (tmp.existsSync()) tmp.deleteSync(recursive: true);
        break;
      } on FileSystemException {
        sleep(const Duration(milliseconds: 100));
      }
    }
  });

  Map<String, dynamic>? last(String type) => sent.lastWhere((m) => m.$2 == type, orElse: () => ('', '', const {})).$3.isEmpty ? null : sent.lastWhere((m) => m.$2 == type).$3;
  String sha(List<int> b) => sha256.convert(b).toString();
  void offer(String id, String name, int size) => rx.handle('pc', 'file.offer', {'transferId': id, 'name': name, 'size': size});
  void chunk(String id, int seq, List<int> b) => rx.handle('pc', 'file.chunk', {'transferId': id, 'seq': seq, 'data': base64Encode(b)});
  void end(String id, String hash) => rx.handle('pc', 'file.end', {'transferId': id, 'sha256': hash});

  void sendAll(String id, String name, Uint8List data, {bool tamper = false}) {
    offer(id, name, data.length);
    var seq = 0;
    for (var o = 0; o < data.length; o += fileChunkBytes) {
      chunk(id, seq++, data.sublist(o, (o + fileChunkBytes).clamp(0, data.length)));
    }
    end(id, tamper ? '0' * 64 : sha(data));
  }

  group('names', () {
    test('never escape the folder or use Windows device names', () {
      expect(safeName('..\\..\\Windows\\evil.exe'), 'evil.exe');
      expect(safeName('../../etc/passwd'), 'passwd');
      expect(safeName('a<b>c:d?.txt'), 'a_b_c_d_.txt');
      expect(safeName('CON.txt'), '_CON.txt');
      expect(safeName('report. '), 'report');
      expect(safeName('..'), 'file');
      expect(safeName('${'x' * 400}.pdf').length, lessThanOrEqualTo(150));
    });
    test('a new name instead of replacing a file', () {
      final have = {'d/a.txt', 'd/a (1).txt'};
      expect(uniquePath('d', 'a.txt', have.contains), 'd/a (2).txt');
    });
  });

  group('receiving', () {
    test('accepts, saves with identical bytes, confirms, and remembers it', () {
      final data = Uint8List.fromList(List.generate(fileChunkBytes * 3 + 123, (i) => (i * 31) % 251));
      sendAll('tid-aaaaaaaa', 'photo.jpg', data);
      expect(last('file.reply')!['ok'], true);
      expect(sent.where((m) => m.$2 == 'file.ack').map((m) => m.$3['seq']).toList(), [0, 1, 2, 3]);
      expect(last('file.result')!['ok'], true);
      final f = rx.received.single;
      expect(f.name, 'photo.jpg');
      expect(f.fromName, 'Office PC');
      expect(File(f.path).readAsBytesSync(), data);
      expect(Directory(dir).listSync().whereType<File>().where((x) => x.path.contains('.part')), isEmpty);
      // survives a restart
      final again = make();
      expect(again.received.map((x) => x.name), ['photo.jpg']);
      again.dispose();
    });

    test('an empty file, and a second file with the same name does not overwrite', () {
      sendAll('tid-bbbbbbbb', 'notes.txt', Uint8List(0));
      sendAll('tid-cccccccc', 'notes.txt', Uint8List.fromList(utf8.encode('second')));
      expect(rx.received.map((f) => f.name).toList()..sort(), ['notes (1).txt', 'notes.txt']);
      expect(File('$dir/notes.txt').lengthSync(), 0);
    });

    test('a damaged file is refused and nothing is left behind', () {
      sendAll('tid-dddddddd', 'doc.pdf', Uint8List.fromList(utf8.encode('hello world')), tamper: true);
      expect(last('file.result')!['ok'], false);
      expect(last('file.result')!['reason'], contains('checksum'));
      expect(rx.received, isEmpty);
      expect(Directory(dir).listSync().whereType<File>().map((f) => f.path.split('/').last).where((n) => !n.startsWith('.index')), isEmpty);
    });

    test('an incomplete file is refused', () {
      offer('tid-eeeeeeee', 'x.bin', 100);
      chunk('tid-eeeeeeee', 0, Uint8List(40));
      end('tid-eeeeeeee', sha(Uint8List(40)));
      expect(last('file.result')!['ok'], false);
      expect(rx.received, isEmpty);
    });

    test('a gap in the chunks cancels it, and extra data is refused', () {
      offer('tid-ffffffff', 'x.bin', 200000);
      chunk('tid-ffffffff', 1, Uint8List(4));
      expect(last('file.cancel'), isNotNull);
      expect(rx.receiving, isEmpty);
      offer('tid-gggggggg', 'y.bin', 3);
      chunk('tid-gggggggg', 0, Uint8List(10));
      expect(rx.receiving, isEmpty);
    });

    test('oversize offers and too many at once are refused', () {
      rx.dispose();
      rx = make(maxBytes: 100);
      offer('tid-hhhhhhhh', 'big', 101);
      expect(last('file.reply')!['ok'], false);
      rx.dispose();
      rx = make();
      for (var i = 0; i < 5; i++) {
        offer('tid-m$i-xxxxxx', 'f$i', 10);
      }
      expect(sent.where((m) => m.$2 == 'file.reply' && m.$3['ok'] == true).length, 4);
      expect(last('file.reply')!['ok'], false);
    });

    test('a cancel from the sender, or the sender going offline, removes the partial file', () {
      offer('tid-iiiiiiii', 'x', 100);
      expect(rx.receiving.length, 1);
      rx.handle('pc', 'file.cancel', {'transferId': 'tid-iiiiiiii'});
      expect(rx.receiving, isEmpty);
      offer('tid-jjjjjjjj', 'x', 100);
      rx.peerLost('pc');
      expect(rx.receiving, isEmpty);
      expect(Directory(dir).listSync().whereType<File>().where((f) => f.path.contains('.part')), isEmpty);
    });

    test('a cancel for a transfer it is not receiving is left to the sender side', () {
      expect(rx.handle('pc', 'file.cancel', {'transferId': 'nothing-here-1'}), false);
    });

    test('deleting a received file removes it from the phone', () {
      sendAll('tid-kkkkkkkk', 'gone.txt', Uint8List.fromList(utf8.encode('bye')));
      final f = rx.received.single;
      rx.delete(f.id);
      expect(File(f.path).existsSync(), false);
      expect(rx.received, isEmpty);
    });
  });
}
