# Solo relay

A tiny hub that lets your Solo devices find each other over the internet (mobile data, different Wi-Fi networks,
anywhere). Every device connects **out** to it, so no port forwarding is needed.

**What it can and cannot see.** It sees which device ids are online and how large messages are. It cannot read
messages: devices encrypt end to end (Ed25519 identities, X25519 + HKDF session keys, AES-256-GCM). There are no
accounts, no database and nothing is stored; all state is in memory. Anyone can run their own.

**Limits built in:** 20 connections per IP, 50 frames/second per connection, 256 KB per message, pairing codes expire
after 2 minutes, and an IP that guesses pairing codes wrongly 10 times is blocked for 10 minutes.

## Run locally

```bash
npm install
npm start -w @solo/relay        # listens on :8080, health check at /healthz
```

Local `ws://` addresses only work for loopback and private networks. Anything on the internet must be `wss://` (TLS),
which every host below provides for you.

## Deploy (pick one free host)

All three build the Dockerfile from the **repository root**.

**Fly.io** (`flyctl` + free allowance; always on if you keep one machine running)
```bash
fly launch --no-deploy --dockerfile apps/relay/Dockerfile --name <your-unique-name> --region <near-you>
fly deploy
```
Then your address is `wss://<your-unique-name>.fly.dev`. Keep `min_machines_running = 1` and
`auto_stop_machines = false` in `fly.toml` so the relay does not sleep (a sleeping relay disconnects devices).

**Render** (Web Service, Docker, root directory = repo root, Dockerfile path `apps/relay/Dockerfile`). Set env
`PORT=8080` and `TRUST_PROXY=1`. Free web services sleep when idle; use a paid instance or ping `/healthz` if you need
it always on.

**Railway** (deploy from the repo, set the Dockerfile path to `apps/relay/Dockerfile`, expose port 8080).

Free-tier terms change; check the host's current limits before relying on it.

After deploying, open Solo on the desktop > Devices > Remote access, enter the `wss://` address and Save. Paired
devices pick the address up automatically. New devices pair with the 12-character code.

## Not included yet
Offline message queues (devices resend their state when they reconnect), TURN for audio/video (needed later for
screen mirroring and call audio over mobile networks), and multiple relay instances (one instance is plenty for a
personal set of devices).
