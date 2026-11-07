import 'package:multicast_dns/multicast_dns.dart';

class FoundDesktop {
  FoundDesktop(this.name, this.host, this.port);
  final String name;
  final String host;
  final int port;
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
      await for (final srv in client.lookup<SrvResourceRecord>(ResourceRecordQuery.service(ptr.domainName))) {
        await for (final ip in client.lookup<IPAddressResourceRecord>(ResourceRecordQuery.addressIPv4(srv.target))) {
          out.add(FoundDesktop(ptr.domainName.split('._solo').first, ip.address.address, srv.port));
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
