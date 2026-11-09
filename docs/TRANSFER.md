# Solo - Sending files between the phone and the computer

## What it does
On the phone, open **Send**, tap *Choose files* (or use **Share** in any app and pick Solo). The files go straight to your
computer over the same encrypted link as everything else: the home network when both are on it, otherwise the internet
through the Solo relay (end-to-end encrypted; the relay only forwards ciphertext). They are saved in
`Downloads\Solo` on the computer and listed under **Files > Received from your phone**. Nothing is stored on a server.

## Computer to phone
On the PC, **Files > Send to your phone**: *Choose files...* or drop files onto the card. Several files can go at once; each
shows progress and can be cancelled. On the phone they appear under **Send > From my computer** while arriving and
afterwards. They are stored *inside* the Solo app (private to it), so:
- **Open** hands the file to another app (through a Solo-only file provider),
- **Save to Downloads** copies it to `Downloads/Solo` where the Files app and other apps can see it
  (on Android 9 and older the phone asks for storage permission the first time),
- **Delete** removes it.
The phone receives in the background service, so files arrive even if the Solo screen is closed (needs the connection to be alive).

## Protocol (packages/shared/src/protocol.ts)
`file.offer {transferId,name,size}` -> `file.reply {ok}` -> `file.chunk {seq,data}` (48 KB raw, up to 8 unacknowledged) ->
`file.ack {seq}` ... -> `file.end {sha256}` -> `file.result {ok}`. Either side can `file.cancel`.
Chunks must arrive in order; the receiver cancels on a gap. Limit 2 GB per file.

## Safety rules on the receiving side (apps/desktop/src/main/files/inbox.ts)
- Only paired, non-revoked devices can send (the link already authenticates them).
- The name is reduced to a plain file name (no folders, no `..`, no Windows device names or reserved characters).
- A file never replaces an existing one (`name (1).ext`), is never opened or run by Solo, and appears under its final
  name only after the size and SHA-256 match what the sender announced. Partial files are deleted on error, cancel or 60 s of silence.
- At most 4 transfers at once.
- Not done: a per-transfer approval prompt (a paired device can send without asking, in both directions), virus scanning, disk-space check before accepting.

## Verified (both directions)
- PC sender (Outbox) against the PC receiver in memory (9 tests): identical bytes over many chunks, the window of 8 is never exceeded, empty file, refusal, unreachable device, cancel leaves nothing behind, device going offline, silence timeout, messages from other devices ignored.
- Phone receiver unit tests (11) and a cross-language test over the real relay with end-to-end encryption (TypeScript sender, Dart receiver): a 500 KB file, an empty file, the same file again (kept as `name (1)`), a folder refused, cancel mid-transfer leaves no partial file.
- Desktop receiver unit tests (13): names, no overwrite, bad checksum, incomplete, gaps, oversize, too many, idle, cancel, restart.
- Cross-language test over the real relay with end-to-end encryption (Dart sender, TypeScript receiver): a 600 KB file, an empty file and a path-traversal name arrive with identical bytes; same name again does not overwrite; cancel leaves no partial file; an unreachable device fails with a clear message.
- Phone Send screen widget tests (8).

## Not built / not verified
- The phone's Open / Save to Downloads buttons, the file provider and the background receiving have not been run on a real handset yet (the Dart side is tested; the Android side is built but unrun).
- Dropping files onto the PC window is built but not tried with a real drag.
- Not yet verified on a real handset with the file chooser and the Share menu (see docs/TESTING.md), and not with a very large file or a slow mobile connection.
- Transfers are not resumed after a failure; the file is sent again from the start. Sending needs the app's background connection to be alive.
