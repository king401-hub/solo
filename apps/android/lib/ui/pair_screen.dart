import 'package:flutter/material.dart';
import '../link/link_api.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.link});
  final LinkApi link;
  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _addr = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _run(Future<String?> Function(String host, int port) f) async {
    final parts = _addr.text.trim().split(':');
    final port = parts.length == 2 ? int.tryParse(parts[1]) : null;
    if (parts.length != 2 || port == null) {
      setState(() => _error = 'Enter the address (ip:port) shown on the desktop');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await f(parts[0], port);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = err;
    });
    if (err == null) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.link.state;
    return ListenableBuilder(
      listenable: widget.link,
      builder: (context, _) => Scaffold(
        appBar: AppBar(title: const Text('Pair with desktop')),
        body: ListView(padding: const EdgeInsets.all(20), children: [
          const Text('On your PC open Solo → Devices. Pick the desktop below, or type the address it shows.'),
          const SizedBox(height: 16),
          for (final d in widget.link.state.discovered)
            ListTile(
              leading: const Icon(Icons.computer),
              title: Text(d.name),
              subtitle: Text('${d.host}:${d.port}'),
              onTap: () => _addr.text = '${d.host}:${d.port}',
            ),
          TextField(
            controller: _addr,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(labelText: 'Address (ip:port)', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          if (_busy && s.sas != null) ...[
            const Text('Confirmation code (approve on your PC only if it matches):'),
            Text(s.sas!, style: Theme.of(context).textTheme.displaySmall?.copyWith(letterSpacing: 8)),
          ],
          FilledButton.tonal(
            onPressed: _busy ? null : () => _run((h, p) => widget.link.ask(h, p)),
            child: Text(_busy ? 'Waiting…' : 'Ask my PC to pair (no code)'),
          ),
          const Divider(height: 32),
          TextField(
            controller: _code,
            keyboardType: TextInputType.number,
            maxLength: 6,
            decoration: const InputDecoration(labelText: 'Or enter the 6-digit code', border: OutlineInputBorder()),
          ),
          if (_error != null) Text(_error!, style: const TextStyle(color: Colors.redAccent)),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy
                ? null
                : () {
                    if (_code.text.trim().length != 6) {
                      setState(() => _error = 'Enter the 6-digit code from the desktop');
                      return;
                    }
                    _run((h, p) => widget.link.pair(h, p, _code.text.trim()));
                  },
            child: const Text('Pair with code'),
          ),
        ]),
      ),
    );
  }
}
