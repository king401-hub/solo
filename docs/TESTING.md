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

## Phase 2.1 manual checklist (phone + PC)
- [ ] Rename this phone on the phone; the PC list updates (also after reconnect).
- [ ] Rename a phone from the PC; the PC shows the alias.
- [ ] Rename the PC from Devices; the phone shows the new name after reconnect.
- [ ] Unpaired phone, "Ask my PC to pair": PC shows card with same 4-digit code as the phone; Approve pairs; Deny shows "denied".
- [ ] Desktop auto-pair on + phone auto-pair on: phone pairs by itself within ~20 s of opening the app.
- [ ] Close the Android app from recents: PC still shows it connected (notification stays).
- [ ] Huawei/EMUI: Settings > Battery > App launch > Solo > manage manually (allow auto-launch, secondary launch, run in background).

## Phase 3 manual checklist
- [ ] Voice > Turn microphone on: first run downloads the model, then Windows mic indicator appears; Off removes it.
- [ ] Say "Hey Solo, what's the time": Heard log shows "for Solo", Solo replies "I heard: ..." (echo until Phase 4).
- [ ] Say a normal sentence without the wake word: log shows "ignored".
- [ ] Talk over Solo's reply: speech stops (barge-in).
- [ ] "Hey Solo" alone: Solo says "Yes?" and takes the next sentence without a wake word.
- [ ] Choose another microphone / voice / speed; settings persist after restart; mic stays OFF after restart.

## Sync + voice checklist (phone + PC)
- [ ] PC Voice > "Solo's voice": Female (default). Test button speaks with a female voice (Zira on Windows).
- [ ] Change speech speed on the PC: phone Settings shows the new value within a few seconds.
- [ ] Change "Keep listening" / "Also wake on Solo" / voice gender on the phone: PC Voice screen updates.
- [ ] Turn the phone's Wi-Fi off, change a setting on the phone, change a different one on the PC, turn Wi-Fi on: both changes appear on both.
- [ ] Phone Settings header says "In sync with <PC name>" while connected and "Offline ..." otherwise.

## Wake word / background checklist
Desktop
- [ ] Voice > Turn microphone on. Close the window (X): Solo icon stays in the tray; say "Hey Solo" and the window comes back and Solo answers.
- [ ] Say "Solo" alone and "Solomon, what time is it": both wake; a sentence containing Solo mid-way does not.
- [ ] Start Solo with Windows + auto microphone: restart Windows, Solo starts hidden in the tray and answers to "Hey Solo".
- [ ] Tray > Quit Solo: nothing listens; relaunching works.
Phone
- [ ] Settings > Listen for "Hey Solo" on this phone: grants microphone, shows notification. Lock the phone / leave the app: say "Hey Solo" - hear "Yes?" without the app opening.
- [ ] "Hey Solo, what's the weather": hear "I heard: ..." (echo until Phase 4); recently heard list updates.
- [ ] Say normal speech without the wake phrase: listed as ignored or not listed, no reply.
- [ ] Notification Stop button stops listening. Swipe the app from recents: listening continues. Force-stop the app: listening stops.
- [ ] Deny the microphone permission: a clear message appears.
- [ ] Change speech speed / voice gender on the desktop: phone replies change without opening the app.
