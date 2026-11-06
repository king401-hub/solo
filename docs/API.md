# Solo — API / Wire Protocol

Source of truth: `packages/shared/src/protocol.ts` (protocol v1).

Transport: WebSocket (TLS). Each frame is a JSON `Envelope`: `{ v, id, ts, from, type, payload }`.

| type | direction | purpose |
|---|---|---|
| `pair.request` / `pair.accept` | either | pairing handshake (device info, public key, code proof) |
| `heartbeat` | either | liveness, battery |
| `notification.sync` | android → windows | notification mirror (app, sender, text, canReply, removed) |
| `task.dispatch` / `task.update` | either | route a task to an agent; report status |
| `sync.delta` | either | row-level sync, last-writer-wins |

Rules: receivers MUST validate with `parseEnvelope`; drop on failure. Major version mismatch → refuse connection.
Planned: `notification.reply`, `media.state/command`, `call.*`, `screen.signal` (WebRTC SDP/ICE).

OpenRouter: standard chat-completions endpoint, called only from the desktop main process.
