import 'dart:async';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'link_client.dart';

/// Entry point of the foreground-service isolate. Must be top-level.
@pragma('vm:entry-point')
void soloServiceEntry() {
  FlutterForegroundTask.setTaskHandler(_LinkTaskHandler());
}

/// Hosts the real [LinkClient] so the desktop connection stays alive when the app UI is closed.
/// Protocol with the UI (maps over the isolate port):
///   UI -> service: {cmd: hello|pair|ask|forget|name|autoPair, id?, ...args}
///   service -> UI: {event: state, state: {...}} | {event: result, id, error?}
class _LinkTaskHandler extends TaskHandler {
  LinkClient? _link;
  String? _lastNotif;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    final link = LinkClient(autoDiscover: true);
    _link = link;
    link.addListener(() {
      FlutterForegroundTask.sendDataToMain({'event': 'state', 'state': link.state.toJson()});
      _updateNotification(link.state);
    });
    await link.start();
  }

  void _updateNotification(LinkState s) {
    final text = switch (s.status) {
      LinkStatus.connected => 'Connected to ${s.desktopName}',
      LinkStatus.connecting => 'Connecting…',
      LinkStatus.offline => 'Waiting for ${s.desktopName ?? 'desktop'}…',
      LinkStatus.unpaired => 'Not paired',
      LinkStatus.rejected => 'Desktop removed this phone',
    };
    if (text == _lastNotif) return;
    _lastNotif = text;
    FlutterForegroundTask.updateService(notificationTitle: 'Solo', notificationText: text);
  }

  @override
  void onReceiveData(Object data) async {
    final link = _link;
    if (link == null || data is! Map) return;
    final id = data['id'];
    Future<void> reply(String? error) async =>
        FlutterForegroundTask.sendDataToMain({'event': 'result', 'id': id, 'error': error});
    switch (data['cmd']) {
      case 'hello':
        FlutterForegroundTask.sendDataToMain({'event': 'state', 'state': link.state.toJson()});
      case 'pair':
        await reply(await link.pair(data['host'] as String, data['port'] as int, data['code'] as String));
      case 'ask':
        await reply(await link.ask(data['host'] as String, data['port'] as int));
      case 'forget':
        await link.forget();
      case 'name':
        await link.setDeviceName(data['name'] as String);
      case 'autoPair':
        await link.setAutoPair(data['on'] as bool);
      case 'setting':
        await link.setAssistantSetting(data['key'] as String, data['value'] as Object);
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    _link?.dispose();
  }
}

/// UI-side proxy for the service. Same API as [LinkClient].
class RemoteLink extends LinkApi {
  LinkState _s = const LinkState();
  @override
  LinkState get state => _s;
  final _pending = <int, Completer<String?>>{};
  int _nextId = 0;
  bool _attached = false;

  void _onData(Object data) {
    if (data is! Map) return;
    if (data['event'] == 'state') {
      _s = LinkState.fromJson(data['state'] as Map);
      notifyListeners();
    } else if (data['event'] == 'result') {
      _pending.remove(data['id'])?.complete(data['error'] as String?);
    }
  }

  /// Configure, start (or reuse) the foreground service and subscribe to its state.
  Future<void> attach() async {
    if (_attached) return;
    _attached = true;
    FlutterForegroundTask.addTaskDataCallback(_onData);
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'solo_link',
        channelName: 'Solo connection',
        channelDescription: 'Keeps Solo connected to your computer.',
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(showNotification: false, playSound: false),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.nothing(),
        autoRunOnBoot: true,
        autoRunOnMyPackageReplaced: true,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
    if (await FlutterForegroundTask.checkNotificationPermission() != NotificationPermission.granted) {
      await FlutterForegroundTask.requestNotificationPermission();
    }
    if (!await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.startService(
        serviceId: 256,
        serviceTypes: [ForegroundServiceTypes.connectedDevice],
        notificationTitle: 'Solo',
        notificationText: 'Starting…',
        callback: soloServiceEntry,
      );
    }
    FlutterForegroundTask.sendDataToTask({'cmd': 'hello'});
  }

  Future<bool> get ignoringBatteryOptimizations => FlutterForegroundTask.isIgnoringBatteryOptimizations;
  Future<void> requestBackgroundExemption() async {
    if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
      await FlutterForegroundTask.requestIgnoreBatteryOptimization();
    }
  }

  Future<String?> _call(Map<String, dynamic> cmd) {
    final id = _nextId++;
    final c = Completer<String?>();
    _pending[id] = c;
    FlutterForegroundTask.sendDataToTask({...cmd, 'id': id});
    return c.future.timeout(const Duration(seconds: 90), onTimeout: () => 'Timed out');
  }

  @override
  Future<String?> pair(String host, int port, String code) => _call({'cmd': 'pair', 'host': host, 'port': port, 'code': code});
  @override
  Future<String?> ask(String host, int port) => _call({'cmd': 'ask', 'host': host, 'port': port});
  @override
  Future<void> forget() async => FlutterForegroundTask.sendDataToTask({'cmd': 'forget'});
  @override
  Future<void> setDeviceName(String name) async => FlutterForegroundTask.sendDataToTask({'cmd': 'name', 'name': name});
  @override
  Future<void> setAutoPair(bool on) async => FlutterForegroundTask.sendDataToTask({'cmd': 'autoPair', 'on': on});
  @override
  Future<void> setAssistantSetting(String key, Object value) async =>
      FlutterForegroundTask.sendDataToTask({'cmd': 'setting', 'key': key, 'value': value});

  @override
  void dispose() {
    FlutterForegroundTask.removeTaskDataCallback(_onData);
    super.dispose();
  }
}
