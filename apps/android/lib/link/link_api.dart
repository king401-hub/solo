import 'package:flutter/foundation.dart';
import 'discovery.dart';

enum LinkStatus { unpaired, connecting, connected, offline, rejected }

/// Plain snapshot of link state. Sent from the background service isolate to the UI as a Map.
class LinkState {
  const LinkState({
    this.status = LinkStatus.unpaired,
    this.lastError,
    this.desktopName,
    this.host,
    this.port,
    this.deviceName = 'My Android phone',
    this.sas,
    this.autoPair = false,
    this.discovered = const [],
    this.settings = const {},
    this.lastSync,
  });
  final LinkStatus status;
  final String? lastError;
  final String? desktopName;
  final String? host;
  final int? port;
  final String deviceName;
  final String? sas; // set while waiting for the desktop user to approve
  final bool autoPair;
  final List<FoundDesktop> discovered;
  /// Synced assistant settings (the shared 'voice' row): wakeWords, quickWord, followUpSeconds, speechRate, voiceGender.
  final Map<String, dynamic> settings;
  final int? lastSync; // epoch ms of the last sync activity

  bool get paired => desktopName != null;

  Map<String, dynamic> toJson() => {
        'status': status.index,
        'lastError': lastError,
        'desktopName': desktopName,
        'host': host,
        'port': port,
        'deviceName': deviceName,
        'sas': sas,
        'autoPair': autoPair,
        'discovered': discovered.map((d) => d.toJson()).toList(),
        'settings': settings,
        'lastSync': lastSync,
      };

  factory LinkState.fromJson(Map<dynamic, dynamic> j) => LinkState(
        status: LinkStatus.values[j['status'] as int],
        lastError: j['lastError'] as String?,
        desktopName: j['desktopName'] as String?,
        host: j['host'] as String?,
        port: j['port'] as int?,
        deviceName: j['deviceName'] as String,
        sas: j['sas'] as String?,
        autoPair: j['autoPair'] as bool,
        discovered: [for (final d in (j['discovered'] as List)) FoundDesktop.fromJson(d as Map)],
        settings: Map<String, dynamic>.from((j['settings'] ?? const {}) as Map),
        lastSync: j['lastSync'] as int?,
      );
}

/// What the UI talks to. Implemented by the in-process [LinkClient] (tests) and by `RemoteLink`,
/// which proxies to the foreground service that keeps the connection alive when the app is closed.
abstract class LinkApi extends ChangeNotifier {
  LinkState get state;

  /// Pair using the 6-digit code shown on the desktop. Returns null on success, else an error message.
  Future<String?> pair(String host, int port, String code);

  /// Code-free pairing: asks the desktop to approve. Returns null on success, else an error message.
  Future<String?> ask(String host, int port);

  Future<void> forget();
  Future<void> setDeviceName(String name);
  Future<void> setAutoPair(bool on);

  /// Change one assistant setting (e.g. 'speechRate'); syncs to every paired device.
  Future<void> setAssistantSetting(String key, Object value);
}
