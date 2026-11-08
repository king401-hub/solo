import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'link/link_api.dart';
import 'link/link_service.dart';
import 'ui/orb.dart';
import 'ui/pair_screen.dart';
import 'ui/settings_screen.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  FlutterForegroundTask.initCommunicationPort();
  final link = RemoteLink();
  runApp(SoloApp(link: link));
  link.attach();
}

class SoloApp extends StatelessWidget {
  const SoloApp({super.key, required this.link});
  final LinkApi link;

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
  final LinkApi link;
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _tab = 0;

  static const _planned = [
    ('Chat', 'Phase 4'),
    ('Tasks', 'Phase 6'),
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
            4 => SettingsScreen(link: widget.link),
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
            NavigationDestination(icon: Icon(Icons.settings), label: 'Settings'),
          ],
        ),
      ),
    );
  }
}

String statusText(LinkState s) {
  final online = s.onlinePeers;
  if (online.isNotEmpty) {
    final names = online.map((p) => p.name).join(', ');
    final remote = online.every((p) => p.via == 'relay');
    return 'Connected to $names${remote ? ' (over the internet)' : ''}';
  }
  return _lanStatusText(s);
}

String _lanStatusText(LinkState s) => switch (s.status) {
      LinkStatus.unpaired => 'Not paired',
      LinkStatus.connecting => s.sas != null ? 'Waiting for approval on your PC…' : 'Connecting…',
      LinkStatus.connected => 'Connected to ${s.desktopName ?? 'desktop'}',
      LinkStatus.offline => 'Desktop unreachable. Retrying…',
      LinkStatus.rejected => s.lastError ?? 'Rejected by desktop',
    };

class _Home extends StatelessWidget {
  const _Home({required this.link});
  final LinkApi link;
  @override
  Widget build(BuildContext context) {
    final s = link.state;
    final canOffer = !s.paired && s.status != LinkStatus.connecting && s.discovered.isNotEmpty;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Orb(state: OrbState.idle),
          const SizedBox(height: 32),
          Text(statusText(s), key: const Key('status')),
          if (s.sas != null) ...[
            const SizedBox(height: 12),
            Text('Confirmation code', style: Theme.of(context).textTheme.bodySmall),
            Text(s.sas!, style: Theme.of(context).textTheme.displaySmall?.copyWith(letterSpacing: 8)),
            const Text('Approve on your PC only if it shows the same code.', textAlign: TextAlign.center),
          ],
          if (s.lastError != null && s.status == LinkStatus.unpaired) ...[
            const SizedBox(height: 8),
            Text(s.lastError!, style: const TextStyle(color: SoloColors.danger)),
          ],
          if (canOffer) ...[
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => link.ask(s.discovered.first.host, s.discovered.first.port),
              icon: const Icon(Icons.link),
              label: Text('Pair with ${s.discovered.first.name.replaceFirst('Solo ', '')}'),
            ),
          ],
        ]),
      ),
    );
  }
}

class _Devices extends StatefulWidget {
  const _Devices({required this.link});
  final LinkApi link;
  @override
  State<_Devices> createState() => _DevicesState();
}

class _DevicesState extends State<_Devices> {
  final _relayUrl = TextEditingController();
  String? _relayErr;
  String? _lastShownUrl;

  Future<void> _saveRelay() async {
    final err = await widget.link.setRelayUrl(_relayUrl.text);
    if (mounted) setState(() => _relayErr = err);
  }

  Future<void> _pairRemote() async {
    final c = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Pair over the internet'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('On the other device open Solo > Devices > Remote access > "Show a pairing code", then type it here.'),
          const SizedBox(height: 12),
          TextField(
            controller: c,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Code (XXXX-XXXX-XXXX)', border: OutlineInputBorder()),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Pair')),
        ],
      ),
    );
    if (code == null || code.trim().isEmpty) return;
    final err = await widget.link.pairRemote(code);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err ?? 'Paired')));
  }

  Future<void> _rename() async {
    final c = TextEditingController(text: widget.link.state.deviceName);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename this phone'),
        content: TextField(controller: c, autofocus: true, maxLength: 80, decoration: const InputDecoration(labelText: 'Name')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Save')),
        ],
      ),
    );
    if (name != null && name.trim().isNotEmpty) await widget.link.setDeviceName(name);
  }

  @override
  Widget build(BuildContext context) {
    final link = widget.link;
    final s = link.state;
    if (s.relayUrl != _lastShownUrl) {
      _lastShownUrl = s.relayUrl;
      _relayUrl.text = s.relayUrl ?? '';
    }
    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Devices', style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 16),
      Card(
        child: ListTile(
          leading: const Icon(Icons.smartphone),
          title: Text(s.deviceName),
          subtitle: const Text('This phone (how your PC sees it)'),
          trailing: IconButton(icon: const Icon(Icons.edit), tooltip: 'Rename this phone', onPressed: _rename),
        ),
      ),
      Card(
        child: ListTile(
          leading: Icon(Icons.computer, color: s.status == LinkStatus.connected ? SoloColors.ok : null),
          title: Text(s.desktopName ?? 'No desktop paired'),
          subtitle: Text(s.paired ? statusText(s) : 'Pair to sync with your PC'),
        ),
      ),
      for (final p in s.peers)
        Card(
          child: ListTile(
            leading: Icon(p.kind == 'android' ? Icons.smartphone : Icons.laptop, color: p.online ? SoloColors.ok : null),
            title: Text(p.name),
            subtitle: Text(p.online ? (p.via == 'relay' ? 'Connected over the internet' : 'Connected on this network') : 'Offline'),
            trailing: IconButton(icon: const Icon(Icons.link_off), tooltip: 'Forget ${p.name}', onPressed: () => link.removePeer(p.id)),
          ),
        ),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Remote access (internet)'),
            const SizedBox(height: 4),
            Text('Reach your laptops from mobile data or any network through your Solo relay. Messages are end-to-end encrypted.',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            TextField(
              controller: _relayUrl,
              keyboardType: TextInputType.url,
              decoration: InputDecoration(
                labelText: 'Relay address (wss://…)',
                border: const OutlineInputBorder(),
                errorText: _relayErr,
                suffixIcon: IconButton(icon: const Icon(Icons.save), tooltip: 'Save relay address', onPressed: _saveRelay),
              ),
              onSubmitted: (_) => _saveRelay(),
            ),
            const SizedBox(height: 8),
            Text(switch (s.relayStatus) {
              'online' => 'Relay connected',
              'connecting' => 'Connecting to the relay…',
              _ => s.relayUrl == null ? 'No relay set (settings from a paired PC fill this in automatically)' : 'Relay off',
            }, key: const Key('relayStatus')),
            const SizedBox(height: 8),
            FilledButton.tonalIcon(
              onPressed: s.relayStatus == 'online' ? _pairRemote : null,
              icon: const Icon(Icons.public),
              label: const Text('Pair over the internet'),
            ),
          ]),
        ),
      ),
      const SizedBox(height: 8),
      if (!s.paired) ...[
        FilledButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PairScreen(link: link))),
          child: const Text('Pair with desktop'),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Pair automatically on this network'),
          subtitle: const Text(
              'Asks the first Solo desktop it finds to pair, without tapping. Your PC still needs to approve (or have auto-approve on). Turn off on shared Wi-Fi.'),
          value: s.autoPair,
          onChanged: link.setAutoPair,
        ),
      ] else
        OutlinedButton(onPressed: link.forget, child: const Text('Unpair')),
      if (link is RemoteLink) ...[
        const SizedBox(height: 16),
        const Text('Stays connected when you close the app (a small notification keeps it running).'),
        const SizedBox(height: 8),
        FutureBuilder<bool>(
          future: link.ignoringBatteryOptimizations,
          builder: (context, snap) => snap.data == true
              ? const SizedBox.shrink()
              : OutlinedButton.icon(
                  onPressed: () async {
                    await link.requestBackgroundExemption();
                    if (mounted) setState(() {});
                  },
                  icon: const Icon(Icons.battery_saver),
                  label: const Text('Allow background activity'),
                ),
        ),
      ],
    ]);
  }
}
