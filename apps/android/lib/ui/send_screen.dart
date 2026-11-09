import 'package:flutter/material.dart';

import '../link/file_receiver.dart';
import '../link/file_sender.dart';
import '../link/link_api.dart';
import '../send/send_controller.dart';
import 'theme.dart';

String fmtBytes(int n) => n >= 1e9 ? '${(n / 1e9).toStringAsFixed(1)} GB' : n >= 1e6 ? '${(n / 1e6).toStringAsFixed(1)} MB' : n >= 1e3 ? '${(n / 1e3).round()} KB' : '$n B';

/// Send files from this phone to a paired computer, over the same encrypted link as everything else (home network,
/// or the internet through the Solo relay). Also reached from Android's Share menu.
class SendScreen extends StatelessWidget {
  const SendScreen({super.key, required this.controller});
  final SendController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Listenable.merge([controller, controller.link]),
        builder: (context, _) {
          final c = controller;
          final transfers = c.link.state.transfers;
          final online = c.onlineComputers;
          final small = Theme.of(context).textTheme.bodySmall;
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('Send and receive files', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 4),
            Text('Pick files here, or use Share in any app and choose Solo. They are sent encrypted, directly to your computer, and saved in its Downloads\\Solo folder. Nothing goes to a Solo server.', style: small),
            const SizedBox(height: 16),
            if (c.computers.isEmpty)
              const Card(child: Padding(padding: EdgeInsets.all(16), child: Text('No computer is paired yet. Pair one in the Devices tab first.')))
            else ...[
              if (online.length > 1)
                Wrap(spacing: 8, children: [
                  for (final p in online)
                    ChoiceChip(label: Text(p.name), selected: c.destination?.id == p.id, onSelected: (_) => c.choose(p.id)),
                ]),
              if (online.isEmpty)
                Text('Your computer is not reachable right now. Make sure Solo is running on it.', key: const Key('sendOffline'), style: small),
              if (online.length == 1) Text('Sending to ${online.first.name}${online.first.via == 'relay' ? ' (over the internet)' : ''}', style: small),
              const SizedBox(height: 8),
              FilledButton.icon(key: const Key('pickFiles'), onPressed: () => c.pick(), icon: const Icon(Icons.upload_file), label: const Text('Choose files')),
            ],
            if (c.pending.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('Ready to send', style: Theme.of(context).textTheme.titleSmall),
              for (final f in c.pending) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(f.name), subtitle: Text(fmtBytes(f.size))),
              Row(children: [
                FilledButton(key: const Key('sendNow'), onPressed: c.destination == null ? null : c.sendPending, child: const Text('Send')),
                const SizedBox(width: 8),
                TextButton(onPressed: c.discardPending, child: const Text('Discard')),
              ]),
            ],
            if (c.message != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(c.message!, key: const Key('sendMessage'), style: const TextStyle(color: SoloColors.danger))),
            if (transfers.isNotEmpty) ...[
              const SizedBox(height: 16),
              Row(children: [
                Expanded(child: Text('Transfers', style: Theme.of(context).textTheme.titleSmall)),
                if (transfers.any((t) => !t.active)) TextButton(onPressed: c.link.clearTransfers, child: const Text('Clear finished')),
              ]),
              for (final t in transfers) _Row(t: t, link: c.link),
            ],
            _Received(c: c, receiving: c.link.state.receiving, received: c.link.state.received),
          ]);
        },
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.t, required this.link});
  final TransferInfo t;
  final LinkApi link;

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    final (text, color) = switch (t.status) {
      TransferStatus.waiting => ('Waiting for ${t.peerName} to accept…', null),
      TransferStatus.sending => ('${fmtBytes(t.sent)} of ${fmtBytes(t.size)}', null),
      TransferStatus.finishing => ('Checking the file arrived intact…', null),
      TransferStatus.done => ('Sent to ${t.peerName}', SoloColors.ok),
      TransferStatus.failed => (t.error ?? 'Failed', SoloColors.danger),
      TransferStatus.cancelled => ('Cancelled', null),
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(t.name, overflow: TextOverflow.ellipsis)),
            if (t.active) IconButton(tooltip: 'Cancel', icon: const Icon(Icons.close), onPressed: () => link.cancelTransfer(t.id)),
          ]),
          if (t.active) LinearProgressIndicator(value: t.status == TransferStatus.sending ? t.progress : null),
          const SizedBox(height: 4),
          Text(text, style: small?.copyWith(color: color), key: Key('transfer-${t.status.name}')),
        ]),
      ),
    );
  }
}

/// Files that arrived from a computer. They are stored inside Solo; Open hands them to another app, Save to Downloads
/// copies them where other apps and the Files app can see them.
class _Received extends StatefulWidget {
  const _Received({required this.c, required this.receiving, required this.received});
  final SendController c;
  final List<TransferInfo> receiving;
  final List<ReceivedInfo> received;
  @override
  State<_Received> createState() => _ReceivedState();
}

class _ReceivedState extends State<_Received> {
  String? _note;

  void _say(String? m) {
    if (m != null && mounted) setState(() => _note = m);
  }

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    if (widget.receiving.isEmpty && widget.received.isEmpty && _note == null) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 16),
      Text('From my computer', style: Theme.of(context).textTheme.titleSmall),
      for (final t in widget.receiving)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(t.name, overflow: TextOverflow.ellipsis),
              LinearProgressIndicator(value: t.size == 0 ? null : t.progress),
              Text('Receiving from ${t.peerName}: ${fmtBytes(t.sent)} of ${fmtBytes(t.size)}', style: small),
            ]),
          ),
        ),
      for (final f in widget.received)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(f.name, overflow: TextOverflow.ellipsis),
              Text('${fmtBytes(f.size)} · from ${f.fromName} · ${DateTime.fromMillisecondsSinceEpoch(f.at).toLocal().toString().substring(0, 16)}', style: small),
              Wrap(spacing: 8, children: [
                TextButton(key: Key('open-${f.id}'), onPressed: () async => _say(await widget.c.openReceived(f.path)), child: const Text('Open')),
                TextButton(key: Key('save-${f.id}'), onPressed: () async => _say(await widget.c.saveReceived(f.path, f.name)), child: const Text('Save to Downloads')),
                TextButton(key: Key('delete-${f.id}'), onPressed: () => widget.c.link.deleteReceived(f.id), child: const Text('Delete')),
              ]),
            ]),
          ),
        ),
      if (_note != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(_note!, key: const Key('receivedNote'), style: small)),
    ]);
  }
}
