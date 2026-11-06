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
