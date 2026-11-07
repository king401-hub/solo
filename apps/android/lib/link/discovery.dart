import 'package:multicast_dns/multicast_dns.dart';

class FoundDesktop {
  FoundDesktop(this.name, this.host, this.port, this.id);
  final String name;
  final String host;
  final int port;
  final String? id; // desktop deviceId from the mDNS TXT record

  Map<String, dynamic> toJson() => {'name': name, 'host': host, 'port': port, 'id': id};
  factory FoundDesktop.fromJson(Map<dynamic, dynamic> j) =>
      FoundDesktop(j['name'] as String, j['host'] as String, j['port'] as int, j['id'] as String?);
}

/// Finds desktops advertising `_solo._tcp` on the LAN. Not covered by automated tests (needs a real
/// network); pairing also works by typing the address shown on the desktop.
Future<List<FoundDesktop>> discoverDesktops({Duration timeout = const Duration(seconds: 4)}) async {
  final client = MDnsClient();
  final out = <FoundDesktop>[];
  try {
    await client.start();
    await for (final ptr in client
        .lookup<PtrResourceRecord>(ResourceRecordQuery.serverPointer('_solo._tcp.local'))
        .timeout(timeout, onTimeout: (s) => s.close())) {
      String? id;
      await for (final txt in client.lookup<TxtResourceRecord>(ResourceRecordQuery.text(ptr.domainName))) {
        for (final line in txt.text.split('\n')) {
          if (line.startsWith('id=')) id = line.substring(3);
        }
        break;
      }
      await for (final srv in client.lookup<SrvResourceRecord>(ResourceRecordQuery.service(ptr.domainName))) {
        await for (final ip in client.lookup<IPAddressResourceRecord>(ResourceRecordQuery.addressIPv4(srv.target))) {
          out.add(FoundDesktop(ptr.domainName.split('._solo').first, ip.address.address, srv.port, id));
          break;
        }
        break;
      }
    }
  } catch (_) {
    // discovery is best-effort
  } finally {
    client.stop();
  }
  return out;
}
