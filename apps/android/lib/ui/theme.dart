import 'package:flutter/material.dart';

/// Mirrors apps/desktop/src/renderer/tokens.css so both apps share one design language.
class SoloColors {
  static const accent = Color(0xFF6C5CE7);
  static const accent2 = Color(0xFF00C2D1);
  static const ok = Color(0xFF22C55E);
  static const warn = Color(0xFFF59E0B);
  static const danger = Color(0xFFEF4444);
}

ThemeData soloTheme(Brightness b) {
  final dark = b == Brightness.dark;
  final bg = dark ? const Color(0xFF0B0D12) : const Color(0xFFF6F7FB);
  final surface = dark ? const Color(0xFF141822) : Colors.white;
  return ThemeData(
    brightness: b,
    useMaterial3: true,
    scaffoldBackgroundColor: bg,
    colorScheme: ColorScheme.fromSeed(seedColor: SoloColors.accent, brightness: b, surface: surface),
    cardTheme: CardThemeData(
      color: surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: dark ? const Color(0xFF232938) : const Color(0xFFE5E7EE)),
      ),
    ),
  );
}
