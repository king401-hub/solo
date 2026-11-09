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

## 0.4.0 - Unreleased
- New `apps/relay` (internet hub) and `packages/crypto` (identity, E2E sessions, pairing proofs; Dart mirror).
- Device ids are now SHA-256 of an Ed25519 public key; `DeviceInfo.pub`. Re-pair existing devices once.
- Desktop: relay client, Hub (LAN + relay), Remote access UI, crypto self-test. Phone: relay client, peers list, pair over the internet, relay address.
- Fix: bundle `@solo/crypto` into the Electron main build; AES-256-GCM instead of ChaCha20-Poly1305 (unsupported in Electron).

## 0.5.0 - Unreleased
- File synchronisation: Syncthing engine supervised by Solo, `files.device` protocol message, Files screen (devices, offers, folders, conflicts, history, ignore rules, privacy), safe default exclusions, docs/SYNC.md.
- Fix: LinkServer.listen now rejects on a busy port so the app falls back to a free port instead of hanging.

## 0.6.0 - Unreleased
- Voice: owner recognition (voice print), owner-only mode, greetings without a wake word, owner-only interruption, Test my voice, Nigerian English/Pidgin helpers, corrections, selectable speech model; Solo no longer listens to itself while speaking. See docs/VOICE.md.
- Phone parity: owner voice recognition, only-my-voice, greetings without a wake word, owner-only interruption, Test my voice, corrections and Nigerian English helpers on Android (Kotlin, ONNX Runtime, Keystore-encrypted voice print). Kotlin results match the desktop on the same audio. See docs/VOICE.md section 6.

## 0.7.0 - Unreleased
- Send files from the phone to the computer: Send tab and Android Share menu on the phone; `file.offer/reply/chunk/ack/end/result/cancel` protocol (48 KB chunks, window of 8, SHA-256 verified, 2 GB limit) over the LAN link or the relay; desktop Inbox saves to DownloadsSolo (safe names, never overwrites, never opens), listed under Files > Received. See docs/TRANSFER.md.
- Send files from the computer to the phone: Files > Send to your phone (choose or drop files, progress, cancel); the phone receives in its background service into app storage, with Open / Save to Downloads / Delete. Same protocol and safety rules as the other direction.

