# Solo — Testing

## Automated
- `npm test` — vitest across workspaces. Phase 1: `@solo/shared` (protocol, policy, budget, memory safety).
- Planned: DB repo tests (Phase 5), orchestrator + mocked OpenRouter (Phase 4/6), Playwright for Electron (Phase 12), Flutter unit/widget tests, contract fixtures shared by TS and Dart.

## Required scenarios (from spec)
1 Windows alone · 2 Android alone · 3 reconnect after outage · 4 history sync · 5 task restore · 6 wake-word reliability · 7 mic disable · 8 guest isolation · 9 unauthorized actions blocked · 10 notification sync · 11 audio routing · 12 crash recovery · 13 budget respected.

## Manual device checklist
Maintained per phase in this file as hardware is exercised (device model, Android version, result).

## Status
| Scenario | Status |
|---|---|
| 8 guest policy (unit level only) | ✔ unit |
| 9 forbidden/confirm gate (unit level only) | ✔ unit |
| 13 budget check (unit level only) | ✔ unit |
| others | not yet testable |

## Phase 2 manual checklist (needs a phone on the same Wi-Fi)
- [ ] Desktop: Devices → Pair a new device shows code + ip:port.
- [ ] Phone: Find desktop on Wi-Fi lists the PC (or type ip:port); correct code pairs; wrong code shows "Wrong code".
- [ ] Desktop status dot turns green; phone Home says Connected.
- [ ] Toggle Wi-Fi off/on on phone: reconnects without re-pairing.
- [ ] Revoke on desktop: phone drops and shows revoked.
- [ ] Windows Firewall prompt on first launch: allow private networks only.
