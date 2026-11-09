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

## Internet access checklist (needs a deployed relay)
- [ ] Deploy the relay (apps/relay/README.md) and note its wss:// address.
- [ ] Desktop > Devices > Remote access: paste the address, Save: status shows Connected.
- [ ] Phone (on the same Wi-Fi first): Devices > the relay address appears automatically after a LAN pairing, or type it; status says Relay connected.
- [ ] Turn Wi-Fi OFF on the phone (mobile data only): phone still shows the PC as "Connected over the internet"; change a setting on either side and see it on the other.
- [ ] Laptop 2 and 3: install, set the same relay address, "Show a pairing code" on the laptop and "Pair over the internet" on the phone. Phone lists all three laptops.
- [ ] Change a setting on laptop 2: laptops 1 and 3 and the phone all update.
- [ ] Revoke the phone on one laptop: that laptop stops receiving from it.
- [ ] Put the laptop to sleep and wake it: it reconnects and catches up.

## File sync: automated and manual
Automated (real engines, one machine, loopback): `npx vitest run sync.integration solo-flow` in apps/desktop. Covers initial sync, edit/rename/delete both ways, exclusions, offline catch-up (8 MB file), conflicts, history and restore, kill-mid-transfer and resume, periodic rescan, API lock-down; plus the Solo layer (identity introduction, offer/accept into a different path, untrusted introductions ignored).

Manual, REQUIRED before relying on it (needs two PCs on different internet connections; loopback cannot test this):
- [ ] On both PCs: Files > Turn on file sync. Allow the Windows firewall prompt for private networks.
- [ ] Both PCs already paired in Devices (LAN or relay). Files shows the other as "Connected for file sync" within a minute or two (public discovery must be on for different networks).
- [ ] PC A: Sync a folder (e.g. D:\Projects\SchoolDom), share with PC B. PC B: accept, choose its own path. Files appear on B.
- [ ] Put PC A on a phone hotspot and PC B on home Wi-Fi (different networks). Edit a file on B in VS Code: it reaches A.
- [ ] Switch PC A off. Edit several files on B (also rename one, delete one, add a big one). Switch A on: it catches up; open the project in Visual Studio.
- [ ] Edit the same file on both while apart: after reconnecting, both versions exist; resolve in Files > Conflicts.
- [ ] History: overwrite a file remotely; Files > History & recovery restores the old version.
- [ ] Confirm node_modules, .git and *.sqlite did not sync. Check Task Manager: no syncthing.exe remains after quitting Solo.
- [ ] Turn off public discovery and relays: sync works on the same network only.

## Voice recognition (needs a person at the PC)
- [ ] Voice > My voice > Teach Solo my voice: read the 5 sentences in a quiet room. It should say "Done".
- [ ] Test my voice: say a full sentence. Note the match score (it needs to be above the line shown). Try again with the TV on, farther from the microphone, a bit faster, and quietly. Adjust Strictness until you are happy.
- [ ] Say only "Hello" / "Hi" / "Good morning" (no "Solo"): Solo should answer in a time-appropriate way. Also try a bare "Hello" in different tones; very short clips can be missed.
- [ ] Ask someone else to say "Hey Solo" and "Good morning": Solo should ignore them (the log shows "ignored (not your voice)").
- [ ] Let Solo speak a long reply: it should not cut itself off. Talk over it: it should stop after about a second (only your voice can do this).
- [ ] Say a sentence with Nigerian English/Pidgin ("abeg open Chrome", "how far"). Check what Solo heard in Recently heard; use Fix to teach it any word it got wrong.
- [ ] Recognition accuracy: try Better (about 75 MB download). If it cannot download, Solo should say so and keep working with Fast.
Automated, opt-in (need models): `SOLO_VOICES_DIR=... npx vitest run voiceId.integration` (real speaker model on sample audio), `asr.bench` (speech model speed/accuracy).

## Phone voice recognition (needs a person and the phone)
- [ ] Settings > My voice > Teach Solo my voice: read the 5 sentences. Note how long "Analysing" takes; it should say "Done".
- [ ] Test my voice: say a full sentence and note the score against the line. Try again with noise, quietly, and farther away.
- [ ] With the screen off, say "Good morning" with no wake word: Solo answers. Ask someone else to say it: Solo ignores them (Recently heard shows the score).
- [ ] While Solo speaks, talk over it: it stops. A different person talking should not stop it.
- [ ] Add a correction ("sorry low" -> "Solo") and check it is applied.
Automated, opt-in: `SOLO_VOICES_DIR=... SOLO_WAVLM_MODEL=... ./gradlew :app:testDebugUnitTest --tests "*SpeakerEmbedderRealTest"` (in apps/android/android).

## Sending files phone -> computer (needs the phone)
- [ ] Phone > Send > Choose files: pick a photo and a PDF. Both show progress, then "Sent to <PC>". They appear in Downloads\Solo and under Files > Received; open them and check they are intact.
- [ ] In the Gallery or Files app choose Share > Solo. The Send tab opens and the file goes to the PC.
- [ ] Send the same file twice: the second is saved as "name (1)", the first is untouched.
- [ ] Turn the PC's Solo off and send: the phone says the computer is not reachable. Turn Solo off in the middle of a big file: the transfer fails clearly and no half file stays in Downloads\Solo.
- [ ] Leave Wi-Fi (mobile data only, relay set up) and send a file: it should say "over the internet" and still arrive.
- [ ] Send a video of a few hundred MB and note the speed.

## Sending files computer -> phone (needs the phone)
- [ ] PC > Files > Send to your phone > Choose files: pick a photo and a PDF. Progress shows on the PC and on the phone (Send tab > From my computer); both end up listed on the phone.
- [ ] Drag a file from Explorer onto the "Send to your phone" card: it is sent.
- [ ] On the phone tap Open on the PDF: a viewer opens it. Tap Save to Downloads: the file appears in the Files app under Downloads/Solo (Android 9: allow the storage permission first).
- [ ] Close the Solo screen on the phone (leave the app running in the background) and send again from the PC: the file still arrives; open Solo to see it.
- [ ] Cancel a large transfer from the PC: the phone shows nothing half-received. Turn the phone's Wi-Fi off mid-transfer: the PC says the phone went offline.
- [ ] Send a few hundred MB over Wi-Fi and note the speed; repeat with the phone on mobile data (relay).

