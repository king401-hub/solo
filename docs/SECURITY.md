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
