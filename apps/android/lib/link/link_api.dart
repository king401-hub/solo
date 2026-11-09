import 'package:flutter/foundation.dart';
import 'discovery.dart';
import 'file_receiver.dart';
import 'file_sender.dart';

enum LinkStatus { unpaired, connecting, connected, offline, rejected }

/// A paired device reachable over the LAN link and/or the internet relay.
class PeerInfo {
  const PeerInfo({required this.id, required this.name, required this.kind, required this.online, this.via});
  final String id;
  final String name;
  final String kind;
  final bool online;
  final String? via; // 'lan' | 'relay' while online

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'kind': kind, 'online': online, 'via': via};
  factory PeerInfo.fromJson(Map j) =>
      PeerInfo(id: j['id'] as String, name: j['name'] as String, kind: j['kind'] as String, online: j['online'] as bool, via: j['via'] as String?);
}

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
    this.peers = const [],
    this.relayUrl,
    this.relayStatus = 'off',
    this.transfers = const [],
    this.receiving = const [],
    this.received = const [],
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
  final List<PeerInfo> peers; // every paired device (laptops), with live reachability
  final String? relayUrl;
  final String relayStatus; // off | connecting | online
  final List<TransferInfo> transfers; // files being sent or recently sent
  final List<TransferInfo> receiving; // files arriving from a computer right now
  final List<ReceivedInfo> received; // files that arrived and are stored in the app

  bool get paired => desktopName != null || peers.isNotEmpty;
  List<PeerInfo> get onlinePeers => [for (final p in peers) if (p.online) p];

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
        'peers': peers.map((p) => p.toJson()).toList(),
        'relayUrl': relayUrl,
        'relayStatus': relayStatus,
        'transfers': transfers.map((t) => t.toJson()).toList(),
        'receiving': receiving.map((t) => t.toJson()).toList(),
        'received': received.map((t) => t.toJson()).toList(),
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
        peers: [for (final p in ((j['peers'] ?? const []) as List)) PeerInfo.fromJson(p as Map)],
        relayUrl: j['relayUrl'] as String?,
        relayStatus: (j['relayStatus'] ?? 'off') as String,
        transfers: [for (final t in ((j['transfers'] ?? const []) as List)) TransferInfo.fromJson(t as Map)],
        receiving: [for (final t in ((j['receiving'] ?? const []) as List)) TransferInfo.fromJson(t as Map)],
        received: [for (final t in ((j['received'] ?? const []) as List)) ReceivedInfo.fromJson(t as Map)],
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

  /// Set the Solo relay address (wss://...). Shared with every paired device. Returns an error message or null.
  Future<String?> setRelayUrl(String url);

  /// Pair with a device on another network using the 12-character code shown there. Returns an error or null.
  Future<String?> pairRemote(String code);

  /// Forget a paired device.
  Future<void> removePeer(String id);

  /// Send a file (already on this phone's storage) to a paired device. Returns an error message or null.
  Future<String?> sendFile(String peerId, String path, String name);
  Future<void> cancelTransfer(String id);
  Future<void> clearTransfers();

  /// Delete a received file from the phone.
  Future<void> deleteReceived(String id);
}
