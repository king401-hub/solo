import { createRelay } from "./server";

const port = Number(process.env["PORT"] ?? 8080);
const relay = createRelay({
  port,
  host: "0.0.0.0",
  // Fly.io / Render / Railway terminate TLS and set X-Forwarded-For; set TRUST_PROXY=1 there.
  trustProxy: process.env["TRUST_PROXY"] === "1",
});
relay.listen().then((p) => console.log(`solo-relay listening on :${p}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void relay.close().then(() => process.exit(0)); });
