import 'package:flutter_test/flutter_test.dart';
import 'package:solo_android/sync/sync_store.dart';

// Mirrors packages/shared/src/sync.test.ts: same inputs, same expected outcomes.
void main() {
  test('higher timestamp wins; ties go to the larger device id', () {
    expect(wins(2, 'a', SyncRow(1, 'z', false, null)), true);
    expect(wins(1, 'z', SyncRow(2, 'a', false, null)), false);
    expect(wins(5, 'b', SyncRow(5, 'a', false, null)), true);
    expect(wins(5, 'a', SyncRow(5, 'b', false, null)), false);
    expect(wins(1, 'a', null), true);
  });

  test('two devices converge regardless of delivery order (tie broken by id)', () {
    final pc = SyncStore('pc', now: () => 1000);
    final phone = SyncStore('phone', now: () => 1000);
    final a = pc.set('settings', 'voice', {'speechRate': 1.2});
    final b = phone.set('settings', 'voice', {'speechRate': 0.8});
    pc.apply(b);
    phone.apply(a);
    expect(pc.get('settings', 'voice'), phone.get('settings', 'voice'));
    expect(pc.get('settings', 'voice'), {'speechRate': 0.8});
  });

  test('a slow clock still overwrites data it has already seen', () {
    final pc = SyncStore('pc', now: () => 10000);
    final phone = SyncStore('phone', now: () => 1000);
    phone.apply(pc.set('settings', 'voice', {'v': 1}));
    final edit = phone.set('settings', 'voice', {'v': 2});
    expect(edit.updatedAt, greaterThan(10000));
    expect(pc.apply(edit), true);
    expect(pc.get('settings', 'voice'), {'v': 2});
  });

  test('stale deltas ignored; deletes propagate', () {
    final pc = SyncStore('pc', now: () => 100);
    pc.set('tasks', 't1', {'x': 2});
    expect(pc.apply(SyncDelta('tasks', 't1', 50, 'phone', false, {'x': 1})), false);
    final del = pc.remove('tasks', 't1');
    expect(pc.get('tasks', 't1'), isNull);
    final phone = SyncStore('phone', now: () => 1);
    phone.apply(SyncDelta('tasks', 't1', 60, 'phone', false, {'x': 1}));
    expect(phone.apply(del), true);
    expect(phone.get('tasks', 't1'), isNull);
  });

  test('offline edits on both sides merge via snapshot exchange', () {
    final pc = SyncStore('pc', now: () => 100);
    final phone = SyncStore('phone', now: () => 100);
    pc.set('settings', 'voice', {'speechRate': 1.5});
    phone.set('settings', 'other', {'n': 1});
    for (final d in pc.all()) {
      phone.apply(d);
    }
    for (final d in phone.all()) {
      pc.apply(d);
    }
    expect(pc.get('settings', 'other'), {'n': 1});
    expect(phone.get('settings', 'voice'), {'speechRate': 1.5});
  });

  test('persists and restores', () {
    final s = SyncStore('pc', now: () => 5);
    s.set('settings', 'voice', {'quickWord': true});
    final back = SyncStore('pc', initial: SyncStore.parse(s.toJsonString()));
    expect(back.get('settings', 'voice'), {'quickWord': true});
    expect(SyncStore.parse('{not json'), isEmpty);
  });

  test('wire payload round-trips and malformed payloads are rejected, not thrown', () {
    final d = SyncDelta('settings', 'voice', 7, 'phone-1', false, {'speechRate': 1.1});
    final back = SyncDelta.fromPayload(d.toPayload())!;
    expect(back.rowId, 'voice');
    expect(back.by, 'phone-1');
    expect(back.data, {'speechRate': 1.1});
    expect(SyncDelta.fromPayload({'table': 'evil', 'rowId': 'x', 'updatedAt': 1, 'by': 'a', 'deleted': false}), isNull);
    expect(SyncDelta.fromPayload({'table': 'settings', 'rowId': 'x', 'updatedAt': 'now', 'by': 'a', 'deleted': false}), isNull);
    expect(SyncDelta.fromPayload('nope'), isNull);
  });
}
