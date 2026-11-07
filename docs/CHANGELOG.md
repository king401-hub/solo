# Changelog

## 0.1.0 — Unreleased (Phase 1 in progress)
- Monorepo scaffold (npm workspaces), git init.
- `@solo/shared`: wire protocol envelope, task/action types, permission policy, model routing/budget, memory types, tests.
- Docs: REQUIREMENTS, ARCHITECTURE, ROADMAP, DATABASE, API, SECURITY, TESTING.
- `@solo/desktop`: Electron + React + TS shell (context isolation, sandbox, CSP, all permission requests denied), design tokens, voice orb preview. Builds cleanly.
- `apps/android`: Flutter scaffold (default template; analyze + test pass). Note: `flutter` needs `--no-version-check` here (git tag fetch fails on this machine).

## 0.2.0 - Unreleased (Phase 2)
- Protocol: `auth.challenge`, `auth.hello`, `auth.ok`, `pair.reject`; `pair.accept` now carries `authToken` (publicKey removed, replaced by TLS cert pinning).
- Desktop: `LinkServer` (wss, pairing, token auth), `DeviceStore`, mDNS advertise, shell UI with working Devices screen.
- Android: Flutter shell, link client, pairing + discovery UI, INTERNET/multicast permissions.

## 0.2.1 - Unreleased
- Protocol: `pair.ask`, `device.rename`; new reject reasons `denied`, `busy`, `forbidden`.
- Desktop: rename (self + devices), pairing approval cards with confirmation code, auto-approve switch.
- Android: rename, code-free pairing, auto-pair switch, foreground service keeping the link alive, IP-change tracking.

## 0.3.0 - Unreleased (Phase 3)
- Shared: voice settings, wake matcher, voice state machine, audio segmenter/resampler.
- Desktop: local Whisper STT, Windows TTS, mic capture + permission gating, Voice screen; Home orb reflects live voice state.

## 0.3.1 - Unreleased
- Sync engine (shared + Dart), `sync.delta` now carries `by`; protocol schema export renamed `SyncDeltaMsg`.
- Voice: female default voice (`voiceGender`), synced assistant settings, phone Settings screen.
- Fix: microphone start failed because Vite inlined the audio worklet as a data: URL (blocked by CSP).

## 0.3.2 - Unreleased
- Wake: "Hi Solo", bare "Solo"/"Solomon" (quick activation default on). Desktop tray + background mode, start with Windows, auto microphone (opt-in). Phone: WakeService (Vosk, TTS), listen switch, permission flow, bundled offline model.
