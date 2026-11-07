# Solo — Architecture

**Principle:** one identity, one memory, one assistant, multiple devices.

## Repository layout (monorepo, npm workspaces)

```
solo/
  packages/shared/   Shared TypeScript contracts: wire protocol, tasks, permissions policy, model routing/budget, memory types.
  apps/desktop/      Electron + React + TypeScript (Windows). Main process owns OS access, DB, agents, audio.
  apps/android/      Flutter UI + Kotlin platform channels (notifications, telecom, MediaProjection). Created in Phase 2.
  docs/              Requirements, architecture, roadmap, DB, API, security, testing, changelog.
```

The Android app cannot import TypeScript; `packages/shared` is the source of truth and the
Dart models are generated/hand-mirrored from the zod schemas (Phase 2: JSON-Schema export + a contract test fixture set both sides must pass).

## Process model (desktop)

| Process | Responsibility |
|---|---|
| Main (Node) | SQLite, OpenRouter client, orchestrator, agents, device link server, secrets (OS keychain via `safeStorage`) |
| Preload | Narrow, typed `contextBridge` API. No Node in renderer. |
| Renderer (React) | UI only. All privileged actions go through IPC. |
| Worker threads (later) | Whisper STT, embeddings, wake-word, so UI/audio never block. |

## Three intelligence systems + orchestrator

```
 mic → [Voice Engine: wake word → STT] → text ┐
 typed text ──────────────────────────────────┤
                                              ▼
                                  [Orchestrator / Intent router]
                          conversation? ─────────┬───────── task? 
                                  ▼                              ▼
                        [Conversational AI]            [Agentic AI]
                        (memory retrieval,        ┌─ Windows Agent ─┐  ┌─ Android Agent ─┐
                         model router)            └──── policy gate ┘  └──── (via link) ─┘
                                  ▼                              ▼
                              [TTS] ◄──────────── results/status
```

- **Intent router** classifies each utterance as *conversation* or *task* (fast/cheap model, with rule-based shortcuts for obvious cases and mode-switch phrases). Conversation never becomes a task implicitly.
- **Policy gate** (`assessAction`) sits between model output and any executor. Models emit structured `Action`s from a closed enum, never raw commands.
- **Model router** maps role → primary + fallbacks (user-editable settings), checks budget before paid calls, prefers `:free` models.

## Device link

- Discovery: mDNS on LAN. Remote: relay-less first (user-supplied tunnel/Tailscale-style address); hosted relay is a later, approved decision.
- Transport: WebSocket (TLS) carrying `Envelope` messages (see `packages/shared/src/protocol.ts`). Media (screen, call audio): WebRTC.
- Pairing: short code shown on one device, entered on other; exchanges public keys, proof via HMAC of the code; keys pinned afterwards.
- Offline-first: each device has its own SQLite. Changes sync as `sync.delta` rows, last-writer-wins on `(updatedAt, deviceId)`, tombstones for deletes. Queue persists across disconnects.

## Storage

SQLite (better-sqlite3) per device; embeddings stored as blobs, with brute-force cosine at first (fine to ~100k rows), `sqlite-vec` later. Schema in DATABASE.md; migration path to PostgreSQL via the same repository interfaces.

## Key decisions

| Decision | Reason |
|---|---|
| Monorepo, no microservices | Single user, avoid infra cost/complexity |
| zod contracts | Runtime validation of untrusted wire/model output + static types |
| Closed action enum + policy gate | Prevent arbitrary model-driven execution |
| Local wake-word + STT | Privacy; no raw audio uploaded |
| Free models first | Limited credit; paid is opt-in with hard budget |

## Known platform limits (design around, don't pretend otherwise)

- WhatsApp has no public call-control API; call answering/audio routing is best-effort via notification actions + Bluetooth HFP, device-dependent.
- Android blocks apps from capturing call audio; laptop-as-headset for cellular calls needs Bluetooth HFP (phone treats laptop as headset) — spike in Phase 8.
- Notification replies only work when the source notification exposes a RemoteInput action.
- MediaProjection requires per-session user consent and a foreground service.

## Wake word and background listening (Phase 3.2)
**Wake phrases:** "Hey Solo", "Hi Solo", "Hey/Hi Solomon" always; bare "Solo" / "Solomon" when quick activation is on (default on). A phrase only counts at the start of an utterance; a bare "Hi" never wakes Solo. The same rules live in `packages/shared/src/voice.ts` (`matchWake`) and `WakeMatcher.kt`, with mirrored tests.

**Desktop:** the renderer owns the microphone (AudioWorklet -> segmenter -> local Whisper in the main process). The main process adds a tray icon, hides the window on close instead of quitting (setting, default on), keeps the renderer unthrottled while hidden, allows a single instance (launching Solo again shows the running one), can start with Windows hidden (`--hidden`), and can turn the microphone on at start-up (opt-in). On a wake word the renderer asks main to `reveal()` the window. Quitting from the tray (or "Quit Solo completely") stops listening: a quit app cannot hear anything.

**Phone:** `WakeService` (Kotlin foreground service, type microphone) listens with the offline Vosk model in two stages: a grammar-limited recognizer for the wake words, then a full recognizer over the last ~3 s of buffered audio plus live audio to confirm the phrase and capture the request. It answers with Android text-to-speech from the service and never starts an Activity, so the app is not opened. Voice settings (gender, speed, quick word, follow-up window) are synced from the desktop by the Dart link service into Flutter's SharedPreferences, which the service reads. The model (`model-en-us`, ~41 MB zipped) is bundled in the APK assets but not committed; fetch it with `apps/android/tools/fetch-vosk-model.ps1`.

**Platform limits:**
- Windows: nothing runs when Solo is fully quit. To be there after a reboot, enable "Start Solo with Windows" and "Turn the microphone on automatically".
- Android: needs RECORD_AUDIO and a visible notification; Android 14+ only lets a microphone foreground service start while the app is visible, so it cannot start at boot; force-stopping the app ends it; Huawei/EMUI may also need "run in the background" allowed. Android shows its microphone indicator while it runs.
