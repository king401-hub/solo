# Solo - Device-to-device file synchronisation

Status: built and tested on one PC with two independent engine instances. **Not yet tested across two real internet
connections** (needs a second PC; see "What is and is not verified").

## 1. What was asked

Keep real folders identical across a user's devices (HP, Dell, Acer, phone), over the internet and not only on one Wi-Fi,
including while devices are off (changes queue and apply on return), with conflict preservation, version history,
exclusions, integrity checks, resumable transfers and no mandatory cloud storage. Files must stay in their normal
folders and remain editable with any program.

## 2. Evaluation (before building anything)

| Option | Verdict |
|---|---|
| **Syncthing** (open source, MPL-2.0, v2.1.7, Go) | **Chosen as the engine.** Mature block-level sync; real files in place; SHA-256 block verification; rename detection; file-system watcher plus periodic rescans; resumes interrupted transfers; versioning; conflicts keep both versions; ignore patterns; TLS device identities; direct connections with UPnP/NAT-PMP, QUIC, public discovery and optional relays; no cloud storage; free. |
| Custom engine (WebRTC data channels + own protocol) | Rejected for now. File sync is exactly the kind of software where a bug destroys user data. Re-implementing block transfer, rename detection, conflict handling, resume, versioning, watcher edge cases and Windows file locking would take far longer to make as safe as Syncthing already is, and the result would be less trustworthy. WebRTC would still need a sync protocol on top. |
| rsync / robocopy / Unison scripts | One-shot or manual; no live watching, no NAT traversal, weak conflict and history story. |
| Cloud drives (OneDrive, Dropbox, Drive) | Violates "no mandatory cloud storage" and puts project files on a third party. |
| Git as the sync mechanism | Not suitable for arbitrary files, binaries, or work-in-progress edits, and needs manual commits. |
| Resilio Sync | Proprietary. |

**Deviation from the preferred approach.** The brief preferred WebRTC data channels with STUN/ICE and TURN. Syncthing does
the same job with its own stack: direct TCP/QUIC connections, UPnP/NAT-PMP port mapping, STUN-style address discovery
for QUIC, discovery servers, and a pool of public relays as the TURN-equivalent fallback (relays only carry encrypted
data). I judged a proven engine more valuable than protocol purity. If WebRTC becomes a hard requirement, the choice
would have to be revisited (a custom transport cannot be swapped into Syncthing).

## 3. Architecture

```
 Solo (Electron main)                                    Syncthing engine (child process, unmodified)
 ----------------------                                  ------------------------------------------
 files/service.ts   policy, UI state, trust   --REST-->  127.0.0.1:<random>, API key, no telemetry,
 files/syncthing.ts process + REST client                no auto-upgrade, no browser
 files/conflicts.ts conflicts & history                   |  TLS between devices, direct or via relay
 files/ignore.ts    safe default exclusions               v
 link/hub.ts        Solo link (LAN + relay)              the other device's engine
```

- **Data plane:** files move engine-to-engine. They do **not** pass through the Solo relay or any Solo server. Nothing is
  stored in the cloud.
- **Control plane:** devices that Solo already trusts introduce their sync identity to each other over the existing
  end-to-end encrypted Solo link (`files.device` message), so the user does not copy 63-character ids. This only
  *introduces* devices. Sharing a folder is always explicit: the owner chooses folder and devices; the receiver sees an
  offer and chooses where it lives on its own disk.
- **Opt-in:** the engine does not run until the user turns on "File sync" (Files screen). Windows will ask to allow
  network access the first time.
- **Engine binary:** pinned version and SHA-256 in `apps/desktop/tools/fetch-syncthing.ps1`; not committed; shipped
  unmodified (MPL-2.0 licence text kept in `resources/syncthing`).
- **Hardening:** API bound to loopback with a random key (a request without the key is refused); usage reports declined;
  crash reports off; automatic upgrades off; the engine's own database folder can never be chosen as a synced folder.
- **Process management:** graceful shutdown (so its database closes cleanly), tree-kill on timeout or crash because
  Syncthing runs as supervisor plus worker and killing only the supervisor orphans the worker (found by testing);
  automatic restart (up to 5 times) if it exits unexpectedly; lock-retry on restart after a crash.

## 4. Requirement mapping

| Requirement | How it is met | Verified by |
|---|---|---|
| Initial folder sync | Folder shared and accepted; engine indexes and transfers | real-engine test |
| Real-time monitoring | File-system watcher (changes picked up ~2 s after the last write) | real-engine test (edit, create, delete, rename both ways) |
| Create / modify / delete / rename | Engine; renames are detected rather than re-sent | real-engine test |
| Incremental sync | Block-level deltas | engine behaviour (not separately measured) |
| Integrity | Block SHA-256 verification; tests compare SHA-256 of whole files | 8 MB and 16 MB files compared byte for byte |
| Offline queue / catch-up | The engine's index records changes while the peer is off; they apply when it returns | OFFLINE test: peer stopped, edits/new/renamed/deleted/8 MB file, peer restarted, trees identical |
| Automatic sync after reconnect | Engine reconnects and reconciles; Solo restarts a crashed engine | same, plus kill-and-restart test |
| Conflicts never silently overwrite | Loser kept as `name.sync-conflict-<date>-<device>.<ext>` on both devices; Conflicts panel offers Keep current / Use the other / Keep both; replaced files go to the Recycle Bin | CONFLICT test: both versions preserved on both devices; resolution actions unit-tested |
| Version history and recovery | Staggered versioning in `.stversions` (default 90 days, configurable); History panel restores any version (the file it replaces goes to the Recycle Bin) | HISTORY test: archived, restored, restored version synced back |
| Selective folders | Any folder, any device subset; per-device destination path | Solo-flow test (different paths) |
| Ignore rules | Per-folder editable `.stignore`; defaults below | ignore test: dependencies, build output, databases and `.git` stay local; `package-lock.json` still syncs |
| Progress and device status | Files screen: per-folder state, percent, bytes left, per-device connected/offline, problems list | UI built; progress values come from engine status (checked in the interrupted-transfer test) |
| Interrupted transfer recovery | Engine resumes from verified blocks | INTERRUPTED test: engine killed mid-transfer, restarted, file completes with identical SHA-256 |
| Periodic reconciliation | Rescan every 5 minutes (configurable) in addition to the watcher | RECONCILIATION test: watcher off, change found by the periodic scan |
| Respect permissions | `ignorePerms` is off, so the engine keeps its normal permission handling | not separately tested |
| Locked files | Engine retries and lists them under "problems" | not separately tested |
| Cloud storage not mandatory | No Solo file storage exists; relays only forward encrypted data | by design |

## 5. Defaults for risky content

Exclusions are on by default and editable per folder:

- **Dependency folders** (`node_modules`, virtual environments, vendor caches): huge, rebuildable, machine-specific.
- **Build output** (`dist`, `build`, `out`, `target`, `.next`, ...). Note: a folder legitimately named `build` or `out`
  in a non-JavaScript project would be skipped; edit the rules if that applies.
- **Caches and temporary files** (swap files, `~$` files, `.DS_Store`, `Thumbs.db`).
- **Live databases** (`*.sqlite`, `*.db`, journals, `*.mdf`): syncing a database while a program has it open can
  corrupt it. Lock files such as `package-lock.json` or `yarn.lock` are *not* excluded.
- **`.git`**: excluded by default. Two machines changing one repository at once can corrupt it; each machine keeps its own
  history (push/pull as usual) while the working files stay identical. It can be switched on per folder; transient git
  lock files stay excluded either way.

## 6. Privacy and network trade-offs

To find each other across different networks the engine can use Syncthing's public discovery servers and, when no direct
path exists, public relays. They learn that devices exist and when they connect, never file contents (the relay carries
TLS between the two devices). Each of the four connection options (public discovery, relays, router port mapping, local
discovery) can be turned off in the Files screen; turning off the first two limits sync to the same network.
Self-hosting Syncthing's discovery and relay servers is possible later. Free-tier/public-service availability is outside
Solo's control.

## 7. What is and is not verified

Verified by automated tests with **two real, independent engine instances** (own keys and databases, loopback): sync both
ways, rename/delete, exclusions, offline catch-up including an 8 MB file, conflicts, history and restore, crash mid-transfer
and resume, periodic rescan, locked-down API; and the Solo layer: identity introduction, folder offer and acceptance into a
different path, rejection of a sync identity from an untrusted device.

**Not verified:**
- Two real PCs on different internet connections (NAT traversal, relay fallback, discovery over the internet). Loopback does
  not exercise any of it. This needs a second machine; a manual checklist is in `docs/TESTING.md`.
- The Files screen as rendered in the app and the native folder picker (built and type-checked; to be exercised by a person).
- Android: **not included.** A phone folder needs Android storage permissions and an engine on the phone; the practical
  route is the separate Syncthing Android app using the same device ids, or a purpose-built Android implementation later.
- Very large folders (hundreds of thousands of files), Windows file locking by other programs, permission handling,
  case-insensitive-name collisions, long paths.
- PGP verification of the pinned engine download (the signing key could not be fetched while pinning); SHA-256 was
  checked against the checksum list published with the release.

## 8. Operations

- Install the engine: `apps/desktop/tools/fetch-syncthing.ps1` (verifies SHA-256).
- Real-engine tests: `npx vitest run sync.integration solo-flow` in `apps/desktop` (skipped when the engine is absent;
  they start several processes, so files run one at a time, see `vitest.config.ts`).
- Upgrading: bump version and hash in the fetch script after verifying the release signature.
