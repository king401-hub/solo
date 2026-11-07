import 'package:flutter/material.dart';

import 'link/link_client.dart';
import 'ui/orb.dart';
import 'ui/pair_screen.dart';
import 'ui/theme.dart';

void main() {
  final link = LinkClient()..start();
  runApp(SoloApp(link: link));
}

class SoloApp extends StatelessWidget {
  const SoloApp({super.key, required this.link});
  final LinkClient link;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Solo',
        theme: soloTheme(Brightness.light),
        darkTheme: soloTheme(Brightness.dark),
        home: Shell(link: link),
      );
}

class Shell extends StatefulWidget {
  const Shell({super.key, required this.link});
  final LinkClient link;
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _tab = 0;

  static const _planned = [
    ('Chat', 'Phase 4'),
    ('Tasks', 'Phase 6'),
    ('More', 'Phase 7+'),
  ];

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.link,
      builder: (context, _) => Scaffold(
        body: SafeArea(
          child: switch (_tab) {
            0 => _Home(link: widget.link),
            1 => _Devices(link: widget.link),
            _ => Center(child: Text('${_planned[_tab - 2].$1} · planned for ${_planned[_tab - 2].$2}')),
          },
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.blur_on), label: 'Solo'),
            NavigationDestination(icon: Icon(Icons.devices), label: 'Devices'),
            NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Chat'),
            NavigationDestination(icon: Icon(Icons.checklist), label: 'Tasks'),
            NavigationDestination(icon: Icon(Icons.more_horiz), label: 'More'),
          ],
        ),
      ),
    );
  }
}

String statusText(LinkClient l) => switch (l.status) {
      LinkStatus.unpaired => 'Not paired',
      LinkStatus.connecting => 'Connecting…',
      LinkStatus.connected => 'Connected to ${l.pairing?.desktopName ?? 'desktop'}',
      LinkStatus.offline => 'Desktop unreachable. Retrying…',
      LinkStatus.rejected => l.lastError ?? 'Rejected by desktop',
    };

class _Home extends StatelessWidget {
  const _Home({required this.link});
  final LinkClient link;
  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Orb(state: OrbState.idle),
          const SizedBox(height: 32),
          Text(statusText(link), key: const Key('status')),
        ]),
      );
}

class _Devices extends StatelessWidget {
  const _Devices({required this.link});
  final LinkClient link;
  @override
  Widget build(BuildContext context) {
    final p = link.pairing;
    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Devices', style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 16),
      Card(
        child: ListTile(
          leading: Icon(Icons.computer, color: link.status == LinkStatus.connected ? SoloColors.ok : null),
          title: Text(p?.desktopName ?? 'No desktop paired'),
          subtitle: Text(p == null ? 'Pair to sync with your PC' : statusText(link)),
        ),
      ),
      const SizedBox(height: 12),
      if (p == null)
        FilledButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PairScreen(link: link))),
          child: const Text('Pair with desktop'),
        )
      else
        OutlinedButton(onPressed: link.forget, child: const Text('Unpair')),
    ]);
  }
}
