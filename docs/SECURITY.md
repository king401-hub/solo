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
| Pairing: short code + key exchange, keys pinned; TLS on link | Phase 2 |
| API key in OS-encrypted store (Electron `safeStorage`), never in renderer, never logged | Phase 4 |
| Secret screen before persisting memory | `shared/memory.ts` `looksSensitive` |
| Guest memory scope isolated; no personal tools | policy + DB scope column |
| Mic: local wake-word, visible indicator, hard off switch | Phase 3 |
| Budget hard-stop | `shared/models.ts` `checkBudget` |

## Rules
- Consequential actions (delete, send, call, shell, sensitive file reads) require confirmation.
- Tasks interrupted by timeout are checkpointed, not dropped.
- Do not bypass Android sandboxing or other apps' private data.
