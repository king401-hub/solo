# Solo — Roadmap

Status: ☐ not started · ◐ in progress · ☑ done (tested)

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Repo, architecture docs, shared contracts, security foundations, design tokens, desktop+Android scaffolds | ☑ done (design tokens + orb are desktop only; Dart contract mirror deferred to Phase 2) |
| 2 Connected apps | Desktop shell, Android shell, pairing, auth, LAN link | ◐ built and unit/integration tested; phone-to-desktop on real hardware not yet tested |
| 3 Voice engine | Wake word, STT, TTS, interruption | ◐ built; speech recognition verified on real audio; live-microphone use not yet tested |
| 4 Conversational AI | OpenRouter client, conversations, routing, fallback | ☐ |
| 5 Memory | 4 categories, embeddings, management UI | ☐ |
| 6 Agentic automation | Windows/Android agents, orchestrator, docs generation | ☐ |
| 7 Phone integration | Notification sync/reply, app launch, contacts | ☐ |
| 8 Audio & calling | Media sync, cellular calls, WhatsApp investigation | ☐ |
| 9 Screen control | MediaProjection mirroring, remote input | ☐ |
| 10 Advanced intelligence | Multi-model routing, vision, specialist agents | ☐ |
| 11 Security & sessions | Guest mode, timers, isolation, remote hardening | ☐ |
| 12 Test & release | Perf/security/device testing, packaging, updates | ☐ |

## Phase 1 — report so far

**Completed:** monorepo, `@solo/shared` (protocol envelope, task/action types, permission policy with guest isolation, model routing + budget check, memory types + secret screen), unit tests, architecture doc.
**Outstanding:** Dart mirror of shared contracts; Flutter design tokens/orb (Android still the default template); electron dev run not visually verified.
**Known limitations:** Dart contract mirror not yet generated. Policy shell deny-list is a backstop, not a sandbox; real safety is the closed action enum + confirmation.

## Phase 2 - report
**Completed:** wss link server (pinned self-signed cert, challenge/response auth, pairing window with lockout, revoke), device store, mDNS advertise, desktop shell (nav, Devices screen with pairing code, status dot), IPC bridge; Android shell (theme matching desktop, orb, Devices/Pair screens), Dart link client (TOFU + pin, reconnect backoff, secure token storage), mDNS discovery, shared proof vectors.
**Tests performed:** 11 desktop vitest tests using a real wss client (pair, reconnect with token, wrong code, no pairing window, MITM fingerprint, unknown/revoked, replay, pre-auth drop, cert stability); shared tests; Dart proof-vector tests (match the TS vectors) and a shell widget test; `tsc` and electron-vite build; the real Electron app launched and answered a TLS `auth.challenge` on :47821.
**Not tested:** Dart `LinkClient` against the real desktop (needs a device/emulator); mDNS discovery on a real network; Windows Firewall prompt; reconnect after Wi-Fi drop on hardware; desktop and phone UI visually (no screenshot review).
**Known limitations:** device tokens are plaintext on desktop disk; manual code/address entry (no QR); offline sync/conflict resolution not built yet; user login deferred to Phase 11 (Phase 2 authenticates devices only); no Android background service, so the link only runs while the app is open.
**Next:** Phase 3 - voice engine.

## Phase 2.1 - report (rename, auto-pair, background link)
**Completed:** rename for this PC, paired phones (desktop alias) and this phone; code-free pairing (`pair.ask`) with desktop approve/deny and 4-digit confirmation code; opt-in auto-approve on desktop and opt-in auto-ask on phone; mDNS discovery also tracks IP changes; Android foreground service hosts the link so it survives closing the app.
**Tests performed:** 10 new desktop tests (ask approve/deny/auto/disconnect/limits, rename, private-address check, SAS); Dart SAS vector + state serialization tests; desktop and Android analysis clean; Android release APK built (17.5 MB).
**Not tested:** installing/running the new APK (phone was not visible to adb); the foreground service on real hardware (Huawei background restrictions are expected to need the manual battery setting); mDNS discovery; auto-pair end to end.

## Phase 3 - report (voice engine)
**Completed:** voice settings, wake-phrase matcher ("Hey Solo"/"Hey Solomon", optional bare "Solo", mis-hearing aliases, wake word must lead the sentence), voice state machine (off/idle/listening/thinking/speaking; barge-in; follow-up window; nothing submitted while the mic is off; ambient speech dropped), energy-based utterance segmenter with pre-roll, resampler, local Whisper (tiny.en, q8) via transformers.js in the main process, Windows voices for speech output (voice/speed selectable), mic capture via AudioWorklet, mic permission gated by an in-app switch, Voice screen (mic switch, status orb, heard log, mic/voice/speed/follow-up settings).
**Tests performed:** 16 unit tests (wake matching, state machine, segmenter, resample); 2 cleanup tests; real-speech check with a Windows-synthesised WAV through Whisper in plain Node and inside Electron 33 (transcribed "Hey Solo, Open Chrome, and search for Dango documentation." and an ambient sentence; wake matcher woke on the first and ignored the second). First model load ~1 min including ~40 MB download, then ~3 s per utterance on this CPU.
**Not tested:** live microphone capture, echo-cancelled barge-in, device switching, speech output through the UI (needs a person at the PC; see TESTING.md).
**Known limitations:** wake word is detected by transcribing speech and matching text, not a dedicated openWakeWord/Porcupine model, so it costs CPU whenever someone speaks and may miss or false-trigger more than a trained detector (dedicated detector is a later upgrade); one utterance is transcribed at a time (speech during transcription is dropped); speaker selection follows the Windows default (Chromium speech synthesis cannot be routed per device); Piper TTS not integrated; no phone-side voice yet; spoken replies are an echo ("I heard: ...") until Phase 4.
**Next:** Phase 4 - conversational AI (OpenRouter).

## Phase 2.2 / 3.1 - report (sync, female voice, mic fix)
**Completed:** generic last-writer-wins sync engine (TypeScript and Dart, same semantics) with hybrid clock, full-state exchange on connect and live deltas, persistence on both sides; voice/assistant settings synced between PC and phone (phone Settings screen); Solo's voice defaults to female (Zira on this PC) and is selectable (female/male/default) with a per-PC specific-voice override; fixed the microphone failing with "The user aborted a request" (the audio worklet was inlined as a data: URL and blocked by the CSP; assets are no longer inlined).
**Tests performed:** 10 shared sync/voice-choice tests; 6 desktop sync integration tests over real wss (connect snapshot, phone-to-PC, relay to a second phone without echo, PC-to-phones, stale data rejected, persistence, malformed deltas dropped); 7 Dart sync tests mirroring the TS cases; all 12 Dart tests and 39 shared + 29 desktop tests pass; built output checked for data: URLs; Electron permission handler probed with a real `getUserMedia` call.
**Not tested:** the fixed microphone flow on your PC (the same call succeeds in a scratch Electron window here, but I have not heard it work in Solo itself); the new APK on the phone; sync phone-to-PC on real devices; spoken female voice by ear.
**Known limitations:** only settings sync so far (memories/tasks/conversations arrive with Phases 4-6); the phone does not speak yet, so voiceGender only affects the PC; sync is last-writer-wins per row (concurrent edits to different fields of the same row: the later write wins as a whole); no Piper voice yet.

## Phase 3.2 - report (wake words in the background, desktop tray, phone listener)
**Completed:** wake phrases ("Hey/Hi Solo", "Hey/Hi Solomon", bare "Solo"/"Solomon" by default) in shared TS and Kotlin with mirrored tests; desktop tray, hide-on-close, single instance, start-with-Windows (hidden), opt-in auto microphone, wake-word reveal of the window, settings card; phone foreground microphone service with offline two-stage wake detection, spoken replies without opening the app, listen switch with permission handling, recent-heard list, desktop-synced voice settings.
**Tests performed:** 42 shared tests (incl. new wake cases); 4 Kotlin JUnit tests on the wake matcher; 14 Dart tests (incl. listen UI and permission denial); desktop typecheck/build; live Windows check: closing the window keeps Solo and its link server running with the window hidden, relaunching brings the window forward.
**Not tested:** on-phone detection and TTS on real hardware (APK installation and a spoken test pending), phone reliability on Huawei background limits, the tray icon appearance, start-with-Windows after a real reboot, desktop wake-from-tray by actual speech.
**Known limitations:** a fully quit desktop app and a force-stopped phone app cannot listen; the phone listener cannot start at boot (Android 14+ rule) and must be switched on again after a restart; phone replies are an echo until Phase 4; no barge-in on the phone yet; phone wake uses the offline Vosk small model (accuracy is below a purpose-trained wake-word model); an extra ~41 MB in the APK.
