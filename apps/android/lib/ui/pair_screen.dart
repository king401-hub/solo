import 'package:flutter/material.dart';
import '../link/discovery.dart';
import '../link/link_client.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.link});
  final LinkClient link;
  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _addr = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false, _scanning = false;
  String? _error;
  List<FoundDesktop> _found = [];

  Future<void> _scan() async {
    setState(() => _scanning = true);
    final r = await discoverDesktops();
    if (!mounted) return;
    setState(() {
      _found = r;
      _scanning = false;
      if (r.isNotEmpty) _addr.text = '${r.first.host}:${r.first.port}';
    });
  }

  Future<void> _pair() async {
    final parts = _addr.text.trim().split(':');
    final port = parts.length == 2 ? int.tryParse(parts[1]) : null;
    if (parts.length != 2 || port == null || _code.text.trim().length != 6) {
      setState(() => _error = 'Enter the address (ip:port) and the 6-digit code from the desktop');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.link.pair(parts[0], port, _code.text.trim());
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = err;
    });
    if (err == null) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair with desktop')),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        const Text('On your PC open Solo → Devices → "Pair a new device", then enter what it shows.'),
        const SizedBox(height: 16),
        OutlinedButton.icon(
          onPressed: _scanning ? null : _scan,
          icon: const Icon(Icons.wifi_find),
          label: Text(_scanning ? 'Searching…' : 'Find desktop on Wi-Fi'),
        ),
        for (final d in _found)
          ListTile(title: Text(d.name), subtitle: Text('${d.host}:${d.port}'), onTap: () => _addr.text = '${d.host}:${d.port}'),
        const SizedBox(height: 12),
        TextField(
          controller: _addr,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(labelText: 'Address (ip:port)', border: OutlineInputBorder()),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _code,
          keyboardType: TextInputType.number,
          maxLength: 6,
          decoration: const InputDecoration(labelText: '6-digit code', border: OutlineInputBorder()),
        ),
        if (_error != null) Text(_error!, style: const TextStyle(color: Colors.redAccent)),
        const SizedBox(height: 12),
        FilledButton(onPressed: _busy ? null : _pair, child: Text(_busy ? 'Pairing…' : 'Pair')),
      ]),
    );
  }
}
