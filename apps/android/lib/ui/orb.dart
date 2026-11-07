import 'package:flutter/material.dart';
import 'theme.dart';

enum OrbState { idle, listening, thinking, speaking, muted }

const _labels = {
  OrbState.idle: 'Say "Hey Solo"',
  OrbState.listening: 'Listening…',
  OrbState.thinking: 'Thinking…',
  OrbState.speaking: 'Speaking',
  OrbState.muted: 'Microphone off',
};

class Orb extends StatefulWidget {
  const Orb({super.key, required this.state});
  final OrbState state;
  @override
  State<Orb> createState() => _OrbState();
}

class _OrbState extends State<Orb> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 2))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.state;
    final color = s == OrbState.muted
        ? Colors.grey
        : s == OrbState.speaking
            ? SoloColors.accent2
            : SoloColors.accent;
    final reduce = MediaQuery.of(context).disableAnimations;
    return Semantics(
      liveRegion: true,
      label: _labels[s],
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        AnimatedBuilder(
          animation: _c,
          builder: (context, child) {
            final k = (s == OrbState.muted || reduce) ? 1.0 : 1 + 0.08 * _c.value;
            return Transform.scale(
              scale: k,
              child: Container(
                width: 160,
                height: 160,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(
                    center: const Alignment(-0.3, -0.4),
                    colors: [Colors.white.withValues(alpha: 0.55), color, color.withValues(alpha: 0)],
                    stops: const [0, 0.55, 0.95],
                  ),
                  boxShadow: [BoxShadow(color: color.withValues(alpha: 0.6), blurRadius: 50)],
                ),
              ),
            );
          },
        ),
        const SizedBox(height: 24),
        Text(_labels[s]!, style: TextStyle(color: Theme.of(context).hintColor)),
      ]),
    );
  }
}
