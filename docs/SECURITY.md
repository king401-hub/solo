# Solo — Security

## Threat model (initial)
Assets: user memory, files, phone notifications, API key, device control channel.
Threats: rogue device on LAN, prompt injection (web pages/notifications telling the model to act), model emitting destructive commands, secret leakage via memory/logs, guest accessing owner data.

## Controls
| Control | Where |
|---|---|
| Closed action enum; no raw model-driven commands | `shared/tasks.ts` |
| Policy gate: safe / confirm / forbidden, shell deny-list, guest blocks | `shared/permissions.ts` |
| Untrusted content (notifications, web, files) is data, never instructions; actions it triggers still need the gate | Orchestrator (Phase 6) |
| Wire messages validated by zod; unknown/malformed dropped | `shared/protocol.ts` |
| Pairing: 6-digit code (2 min TTL, single use, locks after 5 bad tries), HMAC proof bound to nonce + device + TLS cert fingerprint; cert pinned after first pairing; per-device token; revoke | Phase 2 (done, see below) |
| API key in OS-encrypted store (Electron `safeStorage`), never in renderer, never logged | Phase 4 |
| Secret screen before persisting memory | `shared/memory.ts` `looksSensitive` |
| Guest memory scope isolated; no personal tools | policy + DB scope column |
| Mic: local wake-word, visible indicator, hard off switch | Phase 3 |
| Budget hard-stop | `shared/models.ts` `checkBudget` |

## Rules
- Consequential actions (delete, send, call, shell, sensitive file reads) require confirmation.
- Tasks interrupted by timeout are checkpointed, not dropped.
- Do not bypass Android sandboxing or other apps' private data.


## Pairing and link (Phase 2)
- Desktop serves `wss://` with a persisted self-signed EC P-256 cert. The phone records the SHA-256 fingerprint on first pairing and refuses any other cert afterwards.
- First pairing is trust-on-first-use, but the code proof is an HMAC over the fingerprint the phone actually saw, so a man-in-the-middle presenting its own cert cannot produce a proof the desktop accepts (tested).
- After pairing the desktop issues a 256-bit token; every reconnect answers a fresh nonce with `HMAC(token, nonce|deviceId)`. Replay fails (tested). Revoked devices are rejected and disconnected.
- Tokens: desktop `devices.json` (mode 0600, plaintext on disk; not encrypted at rest yet) and Android secure storage. Tokens never go to the renderer or logs.
- Frames are schema-validated; nothing but `auth.hello` / `pair.request` is accepted before authentication; an authenticated socket cannot spoof another device id.
- Known gaps: desktop token file not OS-keychain protected; pairing code is typed manually (no QR); remote (non-LAN) link is Phase 11; user-level login/guest sessions are Phase 11 (Phase 2 authenticates devices only).

## Automatic pairing (Phase 2.1)
- Two independent opt-in switches, both OFF by default: desktop "Pair devices on this network automatically" (skip approval) and phone "Pair automatically on this network" (ask the first desktop found without tapping).
- With both off, a phone must be tapped by the phone owner AND approved on the desktop after comparing a 4-digit code; a man-in-the-middle presenting a different certificate produces a different code.
- With the desktop switch on, any device on the same private network can pair without any check. Trust-on-first-use applies; do not enable on shared or public Wi-Fi. `pair.ask` from non-private addresses is refused.
- Phone side: auto-ask pairs with the first Solo desktop discovered. A rogue "Solo" advertiser on the LAN could be paired with if both the phone switch is on and that peer accepts; leave it off on untrusted networks. After "Unpair" the phone will not auto-ask again for 5 minutes.
- The Android foreground service keeps the link alive in the background; the token lives in Android secure storage.

## Microphone (Phase 3)
- Windows mic access is denied by default. Electron grants `media` (audio only, our own UI only) only while the user has the mic switched on in Solo; switching it off stops all tracks and revokes the grant.
- The mic never auto-starts at launch (the saved `micEnabled` is ignored on load).
- Audio stays on-device: speech is segmented locally, sent only over in-process IPC to the local Whisper model, never to a network service. Ambient speech without a wake word (outside the follow-up window) is transcribed locally for the on-screen log and then discarded; it is never submitted or stored.

## Background listening (Phase 3.2)
- Everything is opt-in and visible: the desktop microphone switch (and the separate "turn on automatically at start" option), the Windows microphone indicator, the tray icon; on Android the listen switch, the permission prompt, the persistent notification with a Stop button and Android's microphone indicator.
- Audio never leaves the device: desktop uses local Whisper, phone uses offline Vosk; nothing is stored. Only the text of what was heard is kept (last few lines, for the on-screen log).
- Two-stage detection on the phone limits false triggers. Ambient speech without a wake phrase is dropped.
- Solo does not execute anything from voice yet (Phase 6 will add confirmation for consequential actions).

## Internet access (relay)
- **What the relay can see:** which device ids are online (ids are hashes of keys, not names), message sizes and timing, and the IP addresses that connect. **It cannot read or alter messages**: they are end-to-end encrypted and authenticated between devices. It stores nothing (memory only). A malicious or compromised relay can drop traffic (denial of service) but cannot impersonate a device or read data.
- **Authentication:** a device proves it owns its id with an Ed25519 signature over a fresh nonce; peers authenticate each other again with signed handshakes against keys learned at pairing, so an id cannot be claimed without its key and a relay cannot insert itself.
- **Pairing codes:** 60 bits, expire in 2 minutes, work once, lock after 5 bad proofs; the relay blocks IPs that guess rendezvous keys (10 failures, 10 minutes). Residual risk: a relay operator who records a pairing exchange could brute-force the 60-bit code offline in principle (about 10^18 guesses); do not treat pairing over an untrusted relay as stronger than the code. Use the same-network pairing (confirmation digits + TLS pin) when possible.
- **Revocation:** removing/revoking a device on a peer makes it ignore that device's relay traffic immediately.
- **Transport:** wss:// (TLS from the host) is mandatory except for loopback/private addresses.
- **Known limits:** no offline message queue (state is re-sent when devices reconnect); keys stored in plaintext files protected only by file permissions (desktop) and Android secure storage (phone); no key rotation or multi-device revocation list yet; the relay sees connection metadata.
- **Pre-release migration:** device ids changed from random values to key hashes, so devices paired before this change must be paired again once.
