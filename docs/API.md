
## Link handshake (v1)
Server: `wss://<desktop-ip>:47821` (falls back to a random port; advertised as mDNS `_solo._tcp` with TXT `id`, `fp`).
- Pair proof: `hex(HMAC-SHA256(key=utf8(code), "solo-pair-v1|<nonce>|<deviceId>|<certSha256 lowercase hex, no colons>"))`
- Auth proof: `hex(HMAC-SHA256(key=utf8(token), "solo-auth-v1|<nonce>|<deviceId>"))`
- Reject reasons: `bad_proof | expired | locked | unknown_device | revoked | version`.
- Test vectors (identical in TS and Dart tests): code `123456`, nonce `00112233445566778899aabbccddeeff`, deviceId `phone-00001`, cert `ab` x32 -> `bb71c281...7d82`; token `cd` x32 -> `916e0270...c0fd`.
- Heartbeat every 15 s from phone; desktop drops silent peers after 45 s; phone reconnects with 1-30 s backoff.
