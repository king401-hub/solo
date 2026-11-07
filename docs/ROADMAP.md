# Solo — Roadmap

Status: ☐ not started · ◐ in progress · ☑ done (tested)

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Repo, architecture docs, shared contracts, security foundations, design tokens, desktop+Android scaffolds | ☑ done (design tokens + orb are desktop only; Dart contract mirror deferred to Phase 2) |
| 2 Connected apps | Desktop shell, Android shell, pairing, auth, LAN link | ◐ built and unit/integration tested; phone-to-desktop on real hardware not yet tested |
| 3 Voice engine | Wake word, STT, TTS, interruption | ☐ |
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
