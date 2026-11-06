# Solo — Roadmap

Status: ☐ not started · ◐ in progress · ☑ done (tested)

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Repo, architecture docs, shared contracts, security foundations, design tokens, desktop+Android scaffolds | ☑ done (design tokens + orb are desktop only; Dart contract mirror deferred to Phase 2) |
| 2 Connected apps | Desktop shell, Android shell, pairing, auth, LAN link | ☐ |
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
