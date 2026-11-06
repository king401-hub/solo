# Solo — Requirements

Condensed from the master project prompt. Full product vision: a Windows + Android personal AI companion with
voice, persistent memory, agentic control of both devices, unified audio/calling and screen mirroring.

## Functional pillars
1. **Voice engine** — local wake word ("Hey Solo"/"Hey Solomon"), local STT, TTS, interruptible, visible mic state, mic can be disabled.
2. **Conversational AI** — OpenRouter, context + memory, distinguishes chat from tasks.
3. **Agentic AI** — Windows Agent, Android Agent, central orchestrator, policy-gated actions.
4. **Model management** — role-based routing, fallbacks, free-first, budget limits, usage dashboard, no hardcoded keys.
5. **Memory** — personal / conversation / project / task; semantic retrieval; view/edit/delete/export/exclude.
6. **Modes** — Conversation, Work, Study, Agent; switchable by voice.
7. **Phone integration** — notification sync/reply, app launch, contacts, calls, media.
8. **Audio & calling** — phone↔laptop audio, cellular calls via Telecom/HFP, WhatsApp call investigation.
9. **Screen mirroring** — MediaProjection → WebRTC.
10. **Sync** — identity, history, memory, tasks, settings; offline-first.
11. **Sessions** — personal vs guest, timers, lock, checkpoint tasks before expiry.
12. **UI** — premium dark/light, voice orb, 10 desktop screens, matching Flutter design.

## Non-functional
- Free/open-source first; no paid dependency without approval; configurable spend cap.
- Privacy: no raw mic upload; no personal files to providers without consent; no secrets in memory/logs.
- Performance: low idle CPU/RAM, configurable background activity.
- Reliability: reconnect, crash-safe task checkpoints.

## Rules
Build by phase; test before claiming; keep docs updated (see ROADMAP.md).
