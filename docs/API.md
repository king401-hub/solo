
## Link handshake (v1)
Server: `wss://<desktop-ip>:47821` (falls back to a random port; advertised as mDNS `_solo._tcp` with TXT `id`, `fp`).
- Pair proof: `hex(HMAC-SHA256(key=utf8(code), "solo-pair-v1|<nonce>|<deviceId>|<certSha256 lowercase hex, no colons>"))`
- Auth proof: `hex(HMAC-SHA256(key=utf8(token), "solo-auth-v1|<nonce>|<deviceId>"))`
- Reject reasons: `bad_proof | expired | locked | unknown_device | revoked | version`.
- Test vectors (identical in TS and Dart tests): code `123456`, nonce `00112233445566778899aabbccddeeff`, deviceId `phone-00001`, cert `ab` x32 -> `bb71c281...7d82`; token `cd` x32 -> `916e0270...c0fd`.
- Heartbeat every 15 s from phone; desktop drops silent peers after 45 s; phone reconnects with 1-30 s backoff.

## Code-free pairing and renaming (Phase 2.1)
- `pair.ask {device}` (android -> windows, before auth): requests pairing without a code. Desktop shows a card with the device name and a 4-digit confirmation `sas = first 4 bytes of SHA-256("solo-sas-v1|<nonce>|<certSha256>") mod 10000`, zero-padded; the phone computes the same from the certificate it actually saw (vector: nonce `00112233445566778899aabbccddeeff`, cert `ab` x32 -> `5621`). Approve/deny on the desktop, or auto-approve if the user enabled it. Accepted only from private/loopback addresses (`forbidden` otherwise); max 3 pending requests and one per device (`busy`); requests expire after 60 s. Replies: `pair.accept` or `pair.reject` (`denied`, `expired`, `busy`, `forbidden`).
- `device.rename {name}` (android -> windows, after auth): updates the label the desktop stores. A user-set desktop alias takes precedence. The desktop's own name travels in `auth.challenge` / `auth.ok` / `pair.accept`.

## Sync (`sync.delta`)
Payload: `{ table: settings|memories|tasks|conversations, rowId, updatedAt, by, deleted, data? }`. `by` is the device that originally wrote the row (a relayed delta keeps the original `by`).
- Conflict rule (identical in `packages/shared/src/sync.ts` and `apps/android/lib/sync/sync_store.dart`): higher `updatedAt` wins; equal timestamps go to the lexicographically larger `by`. `updatedAt` = max(wall clock, highest timestamp ever seen + 1), so a device with a slow clock still wins over data it has already seen.
- On every successful auth both sides send their full state as deltas (tombstones included), so edits made while disconnected merge on reconnect. While connected, local edits are pushed immediately; the desktop relays phone edits to other phones but never echoes to the origin.
- Currently synced: `settings/voice` = `{ wakeWords, quickWord, followUpSeconds, speechRate, voiceGender }`. Device-specific settings (microphone, specific voice, device name) are deliberately not synced. The engine already supports `memories`, `tasks`, `conversations` for Phases 4-6.
- Receivers validate every delta; malformed ones are dropped.
