# Solo - Sending files from the phone to the computer

## What it does
On the phone, open **Send**, tap *Choose files* (or use **Share** in any app and pick Solo). The files go straight to your
computer over the same encrypted link as everything else: the home network when both are on it, otherwise the internet
through the Solo relay (end-to-end encrypted; the relay only forwards ciphertext). They are saved in
`Downloads\Solo` on the computer and listed under **Files > Received from your phone**. Nothing is stored on a server.

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
- Not done: a per-transfer approval prompt (a paired phone can send without asking), virus scanning, disk-space check before accepting.

## Verified
- Desktop receiver unit tests (13): names, no overwrite, bad checksum, incomplete, gaps, oversize, too many, idle, cancel, restart.
- Cross-language test over the real relay with end-to-end encryption (Dart sender, TypeScript receiver): a 600 KB file, an empty file and a path-traversal name arrive with identical bytes; same name again does not overwrite; cancel leaves no partial file; an unreachable device fails with a clear message.
- Phone Send screen widget tests (8).

## Not built / not verified
- Computer to phone (the reverse direction) is not built.
- Not yet verified on a real handset with the file chooser and the Share menu (see docs/TESTING.md), and not with a very large file or a slow mobile connection.
- Transfers are not resumed after a failure; the file is sent again from the start. Sending needs the app's background connection to be alive.
